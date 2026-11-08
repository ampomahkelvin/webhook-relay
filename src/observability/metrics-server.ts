import express from 'express'
import type { Express } from 'express'
import type { Pool } from 'pg'
import type { Metrics } from './metrics.js'
import { healthHandler, metricsHandler } from './control-routes.js'

/**
 * The metrics sidecar every non-api process mounts (DESIGN section 10/11):
 * the dispatcher and the maintenance process listen on PORT and serve the
 * same two control routes the api exposes — `GET /health` (liveness plus a
 * database round-trip) and `GET /metrics`.
 */
export function createMetricsApp({ pool, metrics }: { pool: Pool; metrics: Metrics }): Express {
  const app = express()
  app.disable('x-powered-by')
  app.get('/health', healthHandler(pool))
  app.get('/metrics', metricsHandler(pool, metrics))
  return app
}
