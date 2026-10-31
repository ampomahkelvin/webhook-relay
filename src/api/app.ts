import type { Express, Request, Response } from 'express'
import express from 'express'
import { randomUUID } from 'node:crypto'
import { pinoHttp } from 'pino-http'
import type { Pool } from 'pg'
import type { Logger } from '../logger.js'
import { errorHandler } from './errors.js'
import { healthRouter } from './health.js'
import { adminRouter } from './routes/admin.js'
import { tenantRouter } from './routes/tenant.js'
import type { TenantContext } from '../auth/tenant-auth.js'

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by requireTenantAuth. */
    tenant?: TenantContext
  }
}

export interface AppOptions {
  pool: Pool
  logger: Logger
  adminApiKey: string
  maxEndpointsPerTenant: number
  allowInsecureHttp: boolean
  encryptionKey: string
  intake: { ratePerMinute: number; burst: number }
}

/** Build the Express app. Route modules are added phase by phase. */
export function createApp({
  pool,
  logger,
  adminApiKey,
  maxEndpointsPerTenant,
  allowInsecureHttp,
  encryptionKey,
  intake,
}: AppOptions): Express {
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
  // 300 KB: 256 KB payload plus envelope headroom; tightened in phase 3.
  app.use(express.json({ limit: '300kb' }))

  app.use(healthRouter(pool))
  app.use('/admin', adminRouter({ pool, adminApiKey }))
  app.use(
    '/v1',
    tenantRouter(pool, { maxEndpointsPerTenant, allowInsecureHttp, encryptionKey, intake }),
  )

  // Unknown routes
  app.use((req: Request, res: Response) => {
    res.status(404).json({ code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` })
  })

  app.use(errorHandler(logger))

  return app
}
