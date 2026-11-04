import express from 'express'
import type { Express } from 'express'
import type { Pool } from 'pg'
import type { Metrics } from './metrics.js'

/**
 * The metrics sidecar every non-api process mounts (DESIGN section 10/11):
 * the dispatcher and the maintenance process listen on PORT and serve the
 * same two control routes the api exposes — `GET /health` (liveness plus a
 * database round-trip) and `GET /metrics`.
 */
export function createMetricsApp({ pool, metrics }: { pool: Pool; metrics: Metrics }): Express {
  const app = express()
  app.disable('x-powered-by')

  app.get('/health', (_req, res) => {
    void (async () => {
      try {
        await pool.query('SELECT 1')
        res.status(200).json({
          status: 'ok',
          db: 'up',
          uptimeSeconds: Math.floor(process.uptime()),
        })
      } catch {
        res.status(503).json({ status: 'error', db: 'down' })
      }
    })()
  })

  app.get('/metrics', (_req, res) => {
    void (async () => {
      try {
        res.type('text/plain; charset=utf-8').send(await metrics.render(pool))
      } catch (error) {
        res.status(503).send(`# scrape failed: ${(error as Error).message}\n`)
      }
    })()
  })

  return app
}
