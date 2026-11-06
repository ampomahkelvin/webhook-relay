import { Router } from 'express'
import type { Pool } from 'pg'
import { requireTenantAuth } from '../../auth/tenant-auth.js'
import { endpointRouter, type EndpointRouterOptions } from './endpoints.js'
import { eventsRouter, type IntakeOptions } from './events.js'
import { deliveriesRouter } from './deliveries.js'

export type TenantRouterOptions = EndpointRouterOptions & IntakeOptions

/**
 * Tenant-scoped routes mounted at /v1 (authenticated by the API key).
 * Each sub-router receives exactly the fields its own interface declares:
 * the endpoint router cannot reach intake settings and the intake router
 * cannot reach encryption config.
 */
export function tenantRouter(pool: Pool, options: TenantRouterOptions): Router {
  const router = Router()
  router.use(requireTenantAuth(pool))

  // GET /v1/me — tenant self-check; also what the tests use to verify auth.
  router.get('/me', (req, res) => {
    res.json({ tenant: { id: req.tenant?.tenantId, name: req.tenant?.tenantName } })
  })

  router.use(
    endpointRouter(pool, {
      maxEndpointsPerTenant: options.maxEndpointsPerTenant,
      allowInsecureHttp: options.allowInsecureHttp,
      encryptionKey: options.encryptionKey,
    }),
  )
  router.use(eventsRouter(pool, {
    ratePerMinute: options.ratePerMinute,
    burst: options.burst,
    metrics: options.metrics,
  }))
  router.use(deliveriesRouter(pool))

  return router
}
