import type { Express, Request, Response, NextFunction } from 'express'
import express from 'express'
import { randomUUID } from 'node:crypto'
import { pinoHttp } from 'pino-http'
import type { Pool } from 'pg'
import type { Logger } from '../logger.js'
import { healthRouter } from './health.js'

export interface AppOptions {
  pool: Pool
  logger: Logger
}

/** Build the Express app. Route modules are added phase by phase. */
export function createApp({ pool, logger }: AppOptions): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(
    pinoHttp({
      logger,
      genReqId: () => randomUUID(),
      autoLogging: {
        ignore: (req) => req.url === '/health',
      },
    }),
  )

  app.use(healthRouter(pool))

  // Unknown routes
  app.use((req: Request, res: Response) => {
    res.status(404).json({ code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` })
  })

  // Global error handler. Typed error mapping (409/422/429...) arrives in phase 1.
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction): void => {
    req.log?.error({ err: error }, 'unhandled error')
    if (res.headersSent) {
      res.end()
      return
    }
    res.status(500).json({ code: 'INTERNAL', message: 'Internal server error' })
  })

  return app
}
