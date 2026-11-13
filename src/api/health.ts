import { Router } from 'express'
import type { Pool } from 'pg'
import { fetchQueueGauges } from '../db/queue-stats.js'
import { healthHandler } from '../observability/control-routes.js'

export interface DeepHealthOptions {
  /** Dev-only unsafe flags the deep health route must report (DESIGN section 8). */
  allowInsecureHttp?: boolean
  allowPrivateTargets?: boolean
}

/** GET /health (liveness) and GET /health/deep (lag + unsafe-flag warnings). */
export function healthRouter(pool: Pool, deep: DeepHealthOptions = {}): Router {
  const router = Router()
  router.get('/health', healthHandler(pool))
  router.use(deepHealth(pool, deep))
  return router
}

/**
 * GET /health/deep (DESIGN sections 10/11) — delivery lag and unsafe-flag
 * warnings. Still 200 when only warnings are present: it probes DATABASE
 * state for a human, not the scraper.
 */
function deepHealth(pool: Pool, options: DeepHealthOptions): Router {
  const router = Router()
  router.get('/health/deep', (_req, res) => {
    void (async () => {
      try {
        const gauges = await fetchQueueGauges(pool)
        const warnings: string[] = []
        if (options.allowInsecureHttp) {
          warnings.push('ALLOW_INSECURE_HTTP=true: plain-http receiver URLs are accepted')
        }
        if (options.allowPrivateTargets) {
          warnings.push(
            'ALLOW_PRIVATE_TARGETS=true: send-time IP-range checks are DISABLED — development only',
          )
        }
        res.status(200).json({
          status: warnings.length > 0 ? 'ok-unsafe-flags' : 'ok',
          db: 'up',
          pendingDeliveries: gauges.deliveriesPending,
          oldestDueDeliveryAgeSeconds: gauges.oldestDueDeliveryAgeSeconds,
          endpointsCircuitOpen: gauges.endpointsCircuitOpen,
          warnings,
          uptimeSeconds: Math.floor(process.uptime()),
        })
      } catch (error) {
        res.status(503).json({ status: 'error', db: 'down', error: (error as Error).message })
      }
    })()
  })
  return router
}
