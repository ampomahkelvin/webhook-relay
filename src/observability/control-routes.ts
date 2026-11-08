import type { Request, Response } from 'express'
import type { Pool } from 'pg'
import type { Metrics } from './metrics.js'

/**
 * The control-plane routes every process exposes (DESIGN section 11):
 * `GET /health` (liveness plus a database round-trip) and `GET /metrics`
 * (Prometheus queue gauges). The api mounts them alongside its routes and
 * the dispatcher/maintenance sidecars mount exactly these two — one
 * implementation, no per-process copies that can drift in status codes or
 * exposition details.
 */

/** Liveness: 200 with uptime while a `SELECT 1` round-trips, 503 otherwise. */
export function healthHandler(pool: Pool): (req: Request, res: Response) => void {
  return (_req, res) => {
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
  }
}

/** Prometheus exposition for the queue gauges; 503 when the gauges can't be gathered. */
export function metricsHandler(
  pool: Pool,
  metrics: Metrics,
): (req: Request, res: Response) => void {
  return (_req, res) => {
    void (async () => {
      try {
        res.type('text/plain; charset=utf-8').send(await metrics.render(pool))
      } catch (error) {
        res.status(503).send(`# scrape failed: ${(error as Error).message}\n`)
      }
    })()
  }
}
