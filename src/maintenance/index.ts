import {
  loadConfigOrExit,
  createEntryPool,
  createProcessLogger,
  installSignalHandlers,
} from '../process/bootstrap.js'
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
  const config = loadConfigOrExit()
  const logger = createProcessLogger(config, 'maintenance')
  const pool = createEntryPool(config, logger)

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
    // A persistently failing sweep must be visible; errors never kill the
    // process (the next tick retries), but they are not silent.
    onError: (error) => {
      logger.error({ err: (error as Error).message }, 'maintenance sweep failed')
    },
  })

  installSignalHandlers((signal) => {
    logger.info({ signal }, 'shutting down')
    stopping = true
    void maintenance.then(() =>
      server.close(() => {
        void pool.end().then(() => process.exit(0))
      }),
    )
  })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
