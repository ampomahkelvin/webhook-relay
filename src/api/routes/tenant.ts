import { Router } from 'express'
import type { Pool } from 'pg'
import { requireTenantAuth } from '../../auth/tenant-auth.js'

/** Tenant-scoped routes mounted at /v1. Grows phase by phase. */
export function tenantRouter(pool: Pool): Router {
  const router = Router()
  router.use(requireTenantAuth(pool))

  // GET /v1/me — tenant self-check; also what the tests use to verify auth.
  router.get('/me', (req, res) => {
    res.json({ tenant: { id: req.tenant?.tenantId, name: req.tenant?.tenantName } })
  })

  return router
}
