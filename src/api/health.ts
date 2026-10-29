import { Router } from 'express'
import type { Pool } from 'pg'

/** GET /health — liveness plus a database round-trip. */
export function healthRouter(pool: Pool): Router {
  const router = Router()
  router.get('/health', (_req, res) => {
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
  // /health/deep (delivery lag, unsafe config flags) arrives in phase 8.
  return router
}
