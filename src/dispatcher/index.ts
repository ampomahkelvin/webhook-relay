import { loadConfig, ConfigError } from '../config/index.js'
import { createLogger } from '../logger.js'
import { createPool } from '../db/pool.js'
import { createDispatcher } from './loop.js'

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

  const dispatcher = createDispatcher(
    pool,
    {
      concurrency: config.dispatcherConcurrency,
      batchSize: config.claimBatchSize,
      perEndpointClaimCap: config.perEndpointClaimCap,
      pollIntervalMs: config.pollIntervalMs,
      leaseSeconds: config.leaseSeconds,
      breakerCooldownSeconds: config.breakerCooldownSeconds,
      encryptionKeyBase64: config.encryptionKey,
      requestTimeoutMs: config.requestTimeoutMs,
      allowInsecureHttp: config.allowInsecureHttp,
      allowPrivateTargets: config.allowPrivateTargets,
    },
    logger,
  )
  dispatcher.start()
  logger.info('dispatcher started')

  const shutdown = async () => {
    logger.info('shutdown signal: stopping claims, draining in-flight sends')
    await dispatcher.stop()
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
