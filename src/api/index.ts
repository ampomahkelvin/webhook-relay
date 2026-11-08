import {
  loadConfigOrExit,
  createEntryPool,
  createProcessLogger,
  installSignalHandlers,
} from '../process/bootstrap.js'
import { createApp } from './app.js'
import { Metrics } from '../observability/metrics.js'

async function main(): Promise<void> {
  const config = loadConfigOrExit()
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
    server.close(() => {
      void pool.end().then(() => process.exit(0))
    })
  })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
