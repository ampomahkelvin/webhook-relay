import {
  loadConfigOrExit,
  createEntryPool,
  createProcessLogger,
  installSignalHandlers,
  armHardExit,
  runProcess,
} from './bootstrap.js'
import { loadDispatcherConfig } from '../config/dispatcher.js'
import { createDispatcher } from '../dispatcher/loop.js'
import { createMetricsApp } from '../observability/metrics-server.js'
import { Metrics } from '../observability/metrics.js'

/** The `dispatcher` entrypoint: claim, send, record; drained on SIGTERM. */
async function main(): Promise<void> {
  const config = loadConfigOrExit(loadDispatcherConfig)
  const logger = createProcessLogger(config, 'dispatcher')

  // The send itself holds NO database client (DESIGN: never a transaction
  // across a send) — the pool only serves the short claim, details-read,
  // and record statements, so ~20 slots keep up with any concurrency; a
  // larger pool would just eat Postgres max_connections.
  const pool = createEntryPool(config, logger, {
    max: 20,
  })

  const metrics = new Metrics()
  const dispatcher = createDispatcher(
    pool,
    {
      concurrency: config.dispatcherConcurrency,
      batchSize: config.claimBatchSize,
      perEndpointClaimCap: config.perEndpointClaimCap,
      pollIntervalMs: config.pollIntervalMs,
      leaseSeconds: config.leaseSeconds,
      breakerThreshold: config.breakerThreshold,
      breakerCooldownSeconds: config.breakerCooldownSeconds,
      encryptionKeyBase64: config.encryptionKey,
      requestTimeoutMs: config.requestTimeoutMs,
      allowInsecureHttp: config.allowInsecureHttp,
      allowPrivateTargets: config.allowPrivateTargets,
    },
    logger,
    metrics,
  )
  dispatcher.start()
  logger.info('dispatcher started')

  if (config.allowInsecureHttp || config.allowPrivateTargets) {
    logger.warn(
      'unsafe flags active: ALLOW_INSECURE_HTTP/ALLOW_PRIVATE_TARGETS are development-only',
    )
  }

  const app = createMetricsApp({ pool, metrics })
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'metrics listening')
  })

  installSignalHandlers(() => {
    void shutdown()
  })
  async function shutdown(): Promise<void> {
    logger.info('shutdown signal: stopping claims, draining in-flight sends')
    const hardExit = armHardExit(logger)
    await dispatcher.stop()
    server.close()
    clearTimeout(hardExit)
    await pool.end()
    process.exit(0)
  }
}

runProcess(main)
