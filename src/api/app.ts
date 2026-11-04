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
import { Metrics } from '../observability/metrics.js'
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
  /** Observability hooks; a fresh empty registry is used when omitted. */
  metrics?: Metrics
  /** Dispatcher-side unsafe flag reported by /health/deep. */
  allowPrivateTargets?: boolean
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
  metrics = new Metrics(),
  allowPrivateTargets = false,
}: AppOptions): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(
    pinoHttp({
      logger,
      genReqId: () => randomUUID(),
      // Log hygiene (DESIGN section 9): pino-http otherwise carries raw
      // request headers — including `Authorization: Bearer <key>` — into
      // the log stream. Redact before anything hits disk.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["authorization"]',
          // Opaque producer-chosen token: treat like a bearer key.
          'req.headers["idempotency-key"]',
        ],
        censor: '[REDACTED]',
      },
      autoLogging: {
        ignore: (req) => req.url === '/health' || (req.url?.startsWith('/metrics') ?? false),
      },
    }),
  )
  // 300 KB: 256 KB payload plus envelope headroom; tightened in phase 3.
  app.use(express.json({ limit: '300kb' }))

  app.use(
    healthRouter(pool, {
      allowInsecureHttp,
      allowPrivateTargets,
    }),
  )

  // GET /metrics — Prometheus exposition with the queue gauges (DESIGN 11).
  app.get('/metrics', (_req, res) => {
    void (async () => {
      try {
        res.type('text/plain; charset=utf-8').send(await metrics.render(pool))
      } catch (error) {
        res.status(503).send(`# scrape failed: ${(error as Error).message}\n`)
      }
    })()
  })

  app.use('/admin', adminRouter({ pool, adminApiKey }))
  app.use(
    '/v1',
    tenantRouter(pool, {
      maxEndpointsPerTenant,
      allowInsecureHttp,
      encryptionKey,
      intake,
      metrics,
    }),
  )

  // Unknown routes
  app.use((req: Request, res: Response) => {
    res.status(404).json({ code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` })
  })

  app.use(errorHandler(logger))

  return app
}
