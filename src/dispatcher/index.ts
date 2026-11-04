import { loadConfig, ConfigError } from '../config/index.js'
import { createLogger } from '../logger.js'
import { createPool } from '../db/pool.js'
import { createDispatcher } from './loop.js'
import { createMetricsApp } from '../observability/metrics-server.js'
import { Metrics } from '../observability/metrics.js'

/** The `dispatcher` entrypoint: claim, send, record; drained on SIGTERM. */
async function main(): Promise<void> {
  let config
  try {
    config = loadConfig()
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message)
      process.exit(2)
    }
    throw error
  }
  const logger = createLogger('dispatcher', config.logLevel)
  const pool = createPool(config.databaseUrl)
  pool.on('error', (error) => logger.error({ err: error }, 'idle client error'))

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

  const shutdown = async () => {
    logger.info('shutdown signal: stopping claims, draining in-flight sends')
    await dispatcher.stop()
    server.close()
    await pool.end()
    process.exit(0)
  }
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void shutdown()
    })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
