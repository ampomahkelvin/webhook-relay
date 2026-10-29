import { loadConfig } from '../config/index.js'
import { createPool } from '../db/pool.js'
import { createApp } from './app.js'
import { createLogger } from '../logger.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const logger = createLogger('api', config.logLevel)

  const pool = createPool(config.databaseUrl)
  pool.on('error', (error) => logger.error({ err: error }, 'idle client error'))

  const app = createApp({ pool, logger, adminApiKey: config.adminApiKey })
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'api listening')
  })

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down')
    server.close(() => {
      void pool.end().then(() => process.exit(0))
    })
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
