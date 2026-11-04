import { Router } from 'express'
import type { Pool } from 'pg'
import { requireTenantAuth } from '../../auth/tenant-auth.js'
import { endpointRouter, type EndpointRouterOptions } from './endpoints.js'
import { eventsRouter, type IntakeOptions } from './events.js'
import { deliveriesRouter } from './deliveries.js'
import type { Metrics } from '../../observability/metrics.js'

export type TenantRouterOptions = EndpointRouterOptions & {
  intake: IntakeOptions
  /** Observability hooks passed to the intake router (DESIGN section 11). */
  metrics?: Metrics
}

/** Tenant-scoped routes mounted at /v1 (authenticated by the API key). */
export function tenantRouter(pool: Pool, options: TenantRouterOptions): Router {
  const router = Router()
  router.use(requireTenantAuth(pool))

  // GET /v1/me — tenant self-check; also what the tests use to verify auth.
  router.get('/me', (req, res) => {
    res.json({ tenant: { id: req.tenant?.tenantId, name: req.tenant?.tenantName } })
  })

  router.use(endpointRouter(pool, options))
  router.use(eventsRouter(pool, { ...options.intake, metrics: options.metrics }))
  router.use(deliveriesRouter(pool))

  return router
}
