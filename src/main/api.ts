import {
  loadConfigOrExit,
  createEntryPool,
  createProcessLogger,
  installSignalHandlers,
  armHardExit,
  runProcess,
} from './bootstrap.js'
import { loadApiConfig } from '../config/api.js'
import { createApp } from '../api/app.js'
import { Metrics } from '../observability/metrics.js'

/** The `api` entrypoint: intake, delivery admin, health + metrics. */
async function main(): Promise<void> {
  const config = loadConfigOrExit(loadApiConfig)
  const logger = createProcessLogger(config, 'api')

  const pool = createEntryPool(config, logger)

  const app = createApp({
    pool,
    logger,
    adminApiKey: config.adminApiKey,
    maxEndpointsPerTenant: config.maxEndpointsPerTenant,
    allowInsecureHttp: config.allowInsecureHttp,
    allowPrivateTargets: config.allowPrivateTargets,
    encryptionKey: config.encryptionKey,
    intake: { ratePerMinute: config.intakeRatePerMinute, burst: config.intakeBurst },
    metrics: new Metrics(),
  })
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'api listening')
  })

  installSignalHandlers((signal) => {
    logger.info({ signal }, 'shutting down')
    const hardExit = armHardExit(logger)
    server.close(() => {
      clearTimeout(hardExit)
      void pool.end().then(() => process.exit(0))
    })
  })
}

runProcess(main)
