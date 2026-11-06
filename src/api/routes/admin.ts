import { Router } from 'express'
import { z } from 'zod'
import type { Pool } from 'pg'
import { AppError, parseBody } from '../errors.js'
import { generateApiKey } from '../../auth/api-keys.js'
import { requireAdminKey } from '../../auth/admin-auth.js'
import { isUuid } from '../../util/uuid.js'
import {
  createTenant,
  getTenant,
  insertApiKey,
  listApiKeys,
  listTenants,
  revokeApiKey,
} from '../../db/tenants.js'
import { apiKeyJson, tenantJson } from '../serialize.js'

export interface AdminRouterOptions {
  pool: Pool
  adminApiKey: string
}

const createTenantSchema = z.object({
  name: z.string().trim().min(1).max(100),
})

/**
 * Admin namespace (requires `ADMIN_API_KEY` per DESIGN section 9/10):
 * creates tenants and issues/revokes their API keys. Keys are plain
 * `sha256` hashes in the database and returned in full exactly once.
 */
export function adminRouter({ pool, adminApiKey }: AdminRouterOptions): Router {
  const router = Router()
  router.use(requireAdminKey(adminApiKey))

  // Route params: bad tenant id says "Tenant not found", bad key id says
  // "API key not found" — the unspecific alias hides which path param is wrong.
  const tenantId = (req: { params: Record<string, string> }): string => {
    const id = req.params['id'] ?? ''
    if (!isUuid(id)) throw new AppError(404, 'NOT_FOUND', 'Tenant not found')
    return id
  }
  const keyId = (req: { params: Record<string, string> }): string => {
    const id = req.params['keyId'] ?? ''
    if (!isUuid(id)) throw new AppError(404, 'NOT_FOUND', 'API key not found')
    return id
  }
  const requireTenant = async (id: string) => {
    const tenant = await getTenant(pool, id)
    if (!tenant) throw new AppError(404, 'NOT_FOUND', 'Tenant not found')
    return tenant
  }

  // POST /admin/tenants — creates the tenant and its first API key in one transaction.
  router.post('/tenants', async (req, res) => {
    const { name } = parseBody(createTenantSchema, req.body)
    const issued = generateApiKey()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const tenant = await createTenant(client, name)
      const keyDbId = await insertApiKey(client, tenant.id, issued.keyHash, issued.keyPrefix)
      await client.query('COMMIT')
      res.status(201).json({
        tenant: tenantJson(tenant),
        apiKey: { id: keyDbId, key: issued.key },
      })
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })

  // GET /admin/tenants — simple listing for the admin.
  router.get('/tenants', async (_req, res) => {
    res.json({ tenants: (await listTenants(pool)).map(tenantJson) })
  })

  // GET /admin/tenants/:id — one tenant.
  router.get('/tenants/:id', async (req, res) => {
    res.json({ tenant: tenantJson(await requireTenant(tenantId(req))) })
  })

  // POST /admin/tenants/:id/api-keys — issue an additional key (rotation).
  router.post('/tenants/:id/api-keys', async (req, res) => {
    const id = tenantId(req)
    await requireTenant(id)
    const issued = generateApiKey()
    const keyDbId = await insertApiKey(pool, id, issued.keyHash, issued.keyPrefix)
    res.status(201).json({ apiKey: { id: keyDbId, key: issued.key } })
  })

  // GET /admin/tenants/:id/api-keys — list (prefix only; never the secret).
  router.get('/tenants/:id/api-keys', async (req, res) => {
    const id = tenantId(req)
    await requireTenant(id)
    res.json({ apiKeys: (await listApiKeys(pool, id)).map(apiKeyJson) })
  })

  // POST /admin/tenants/:id/api-keys/:keyId/revoke — idempotent.
  router.post('/tenants/:id/api-keys/:keyId/revoke', async (req, res) => {
    const id = tenantId(req)
    const key = keyId(req)
    await requireTenant(id)
    const outcome = await revokeApiKey(pool, { tenantId: id, keyId: key })
    if (outcome === 'not_found') throw new AppError(404, 'NOT_FOUND', 'API key not found')
    // 'already_revoked' is intentional idempotency, not an error.
    res.status(204).end()
  })

  return router
}
