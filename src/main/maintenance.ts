import {
  loadConfigOrExit,
  createEntryPool,
  createProcessLogger,
  installSignalHandlers,
  armHardExit,
  runProcess,
} from './bootstrap.js'
import { loadMaintenanceConfig } from '../config/maintenance.js'
import { runMaintenanceLoop } from '../maintenance/loop.js'
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
  const config = loadConfigOrExit(loadMaintenanceConfig)
  const logger = createProcessLogger(config, 'maintenance')
  const pool = createEntryPool(config, logger)

  const metrics = new Metrics()
  const app = createMetricsApp({ pool, metrics })
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'maintenance listening')
  })

  let stopping = false
  // I7: the between-sweeps sleep is abortable, so a stop signal ends the
  // loop immediately instead of after up to a full interval.
  const stopSignal = new AbortController()
  const maintenance = runMaintenanceLoop(pool, {
    retentionDays: config.retentionDays,
    deliveryMaxAgeHours: config.deliveryMaxAgeHours,
    autoDisableAfterDays: config.autoDisableAfterDays,
    intervalMs: SWEEP_INTERVAL_MS,
    shouldStop: () => stopping,
    signal: stopSignal.signal,
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
    stopSignal.abort()
    const hardExit = armHardExit(logger)
    void maintenance.then(() =>
      server.close(() => {
        clearTimeout(hardExit)
        void pool.end().then(() => process.exit(0))
      }),
    )
  })
}

runProcess(main)
