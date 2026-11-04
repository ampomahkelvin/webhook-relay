import { loadConfig, ConfigError } from '../config/index.js'
import { createLogger } from '../logger.js'
import { createPool } from '../db/pool.js'
import { runMaintenanceLoop } from './sweep.js'
import { createMetricsApp } from '../observability/metrics-server.js'
import { Metrics } from '../observability/metrics.js'

/** Sweep cadence; every cycle re-competes for the advisory lock. */
const SWEEP_INTERVAL_MS = 60_000

/**
 * The `maintenance` entrypoint: retention pruning, the expiry sweep, and
 * auto-disable, single-instance through the advisory lock, plus `/health`
 * and `/metrics` on PORT for the scraper.
 */
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
  const logger = createLogger('maintenance', config.logLevel)
  const pool = createPool(config.databaseUrl)
  pool.on('error', (error) => logger.error({ err: error }, 'idle client error'))

  const metrics = new Metrics()
  const app = createMetricsApp({ pool, metrics })
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'maintenance listening')
  })

  let stopping = false
  const maintenance = runMaintenanceLoop(pool, {
    retentionDays: config.retentionDays,
    deliveryMaxAgeHours: config.deliveryMaxAgeHours,
    autoDisableAfterDays: config.autoDisableAfterDays,
    intervalMs: SWEEP_INTERVAL_MS,
    shouldStop: () => stopping,
    onSweep: (result) => {
      logger.info(
        {
          eventsDeleted: result.eventsDeleted,
          deliveriesExpired: result.deliveriesExpired,
          endpointsDisabled: result.endpointsDisabled,
        },
        'maintenance sweep',
      )
    },
  })

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down')
    stopping = true
    void maintenance.then(() =>
      server.close(() => {
        void pool.end().then(() => process.exit(0))
      }),
    )
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
