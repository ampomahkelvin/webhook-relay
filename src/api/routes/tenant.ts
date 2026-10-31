import { Router } from 'express'
import type { Pool } from 'pg'
import { requireTenantAuth } from '../../auth/tenant-auth.js'
import { endpointRouter, type EndpointRouterOptions } from './endpoints.js'
import { eventsRouter, type IntakeOptions } from './events.js'

export type TenantRouterOptions = EndpointRouterOptions & { intake: IntakeOptions }

/** Tenant-scoped routes mounted at /v1 (authenticated by the API key). */
export function tenantRouter(pool: Pool, options: TenantRouterOptions): Router {
  const router = Router()
  router.use(requireTenantAuth(pool))

  // GET /v1/me — tenant self-check; also what the tests use to verify auth.
  router.get('/me', (req, res) => {
    res.json({ tenant: { id: req.tenant?.tenantId, name: req.tenant?.tenantName } })
  })

  router.use(endpointRouter(pool, options))
  router.use(eventsRouter(pool, options.intake))

  return router
}
