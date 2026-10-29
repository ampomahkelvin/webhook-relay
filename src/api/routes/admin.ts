import { Router } from 'express'
import { z } from 'zod'
import type { Pool } from 'pg'
import { AppError, parseBody } from '../errors.js'
import { generateApiKey } from '../../auth/api-keys.js'
import { requireAdminKey } from '../../auth/admin-auth.js'
import { isUuid } from '../../util/uuid.js'

export interface AdminRouterOptions {
  pool: Pool
  adminApiKey: string
}

const createTenantSchema = z.object({
  name: z.string().trim().min(1).max(100),
})

interface TenantRow {
  id: string
  name: string
  created_at: Date
}

interface ApiKeyRow {
  id: string
  key_prefix: string
  created_at: Date
  revoked_at: Date | null
}

function tenantJson(row: TenantRow) {
  return { id: row.id, name: row.name, createdAt: row.created_at.toISOString() }
}

function apiKeyJson(row: ApiKeyRow) {
  return {
    id: row.id,
    prefix: row.key_prefix,
    createdAt: row.created_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
  }
}

/**
 * Admin namespace (requires `ADMIN_API_KEY` per DESIGN section 9/10):
 * creates tenants and issues/revokes their API keys. Keys are plain
 * `sha256` hashes in the database and returned in full exactly once.
 */
export function adminRouter({ pool, adminApiKey }: AdminRouterOptions): Router {
  const router = Router()
  router.use(requireAdminKey(adminApiKey))

  const tenantExists = async (tenantId: string): Promise<TenantRow> => {
    const result = await pool.query<TenantRow>(
      'SELECT id, name, created_at FROM tenants WHERE id = $1',
      [tenantId],
    )
    const row = result.rows[0]
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Tenant not found')
    return row
  }

  // POST /admin/tenants — creates the tenant and its first API key in one transaction.
  router.post('/tenants', async (req, res) => {
    const { name } = parseBody(createTenantSchema, req.body)
    const issued = generateApiKey()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const tenantResult = await client.query<TenantRow>(
        'INSERT INTO tenants (name) VALUES ($1) RETURNING id, name, created_at',
        [name],
      )
      const tenant = tenantResult.rows[0]
      if (!tenant) throw new AppError(500, 'INTERNAL', 'Tenant insert returned no row')
      const keyResult = await client.query<{ id: string }>(
        'INSERT INTO api_keys (tenant_id, key_hash, key_prefix) VALUES ($1, $2, $3) RETURNING id',
        [tenant.id, issued.keyHash, issued.keyPrefix],
      )
      const keyId = keyResult.rows[0]?.id
      if (!keyId) throw new AppError(500, 'INTERNAL', 'API key insert returned no row')
      await client.query('COMMIT')
      res.status(201).json({
        tenant: tenantJson(tenant),
        apiKey: { id: keyId, key: issued.key },
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
    const result = await pool.query<TenantRow>(
      'SELECT id, name, created_at FROM tenants ORDER BY created_at DESC LIMIT 100',
    )
    res.json({ tenants: result.rows.map(tenantJson) })
  })

  // GET /admin/tenants/:id — one tenant.
  router.get('/tenants/:id', async (req, res) => {
    const id = req.params['id'] ?? ''
    if (!isUuid(id)) throw new AppError(404, 'NOT_FOUND', 'Tenant not found')
    res.json({ tenant: tenantJson(await tenantExists(id)) })
  })

  // POST /admin/tenants/:id/api-keys — issue an additional key (rotation).
  router.post('/tenants/:id/api-keys', async (req, res) => {
    const id = req.params['id'] ?? ''
    if (!isUuid(id)) throw new AppError(404, 'NOT_FOUND', 'Tenant not found')
    await tenantExists(id)
    const issued = generateApiKey()
    const result = await pool.query<{ id: string }>(
      'INSERT INTO api_keys (tenant_id, key_hash, key_prefix) VALUES ($1, $2, $3) RETURNING id',
      [id, issued.keyHash, issued.keyPrefix],
    )
    res.status(201).json({ apiKey: { id: result.rows[0]?.id, key: issued.key } })
  })

  // GET /admin/tenants/:id/api-keys — list (prefix only; never the secret).
  router.get('/tenants/:id/api-keys', async (req, res) => {
    const id = req.params['id'] ?? ''
    if (!isUuid(id)) throw new AppError(404, 'NOT_FOUND', 'Tenant not found')
    await tenantExists(id)
    const result = await pool.query<ApiKeyRow>(
      'SELECT id, key_prefix, created_at, revoked_at FROM api_keys WHERE tenant_id = $1 ORDER BY created_at',
      [id],
    )
    res.json({ apiKeys: result.rows.map(apiKeyJson) })
  })

  // POST /admin/tenants/:id/api-keys/:keyId/revoke — idempotent.
  router.post('/tenants/:id/api-keys/:keyId/revoke', async (req, res) => {
    const id = req.params['id'] ?? ''
    const keyId = req.params['keyId'] ?? ''
    if (!isUuid(id) || !isUuid(keyId)) throw new AppError(404, 'NOT_FOUND', 'Tenant not found')
    await tenantExists(id)
    const result = await pool.query<{ id: string }>(
      `UPDATE api_keys SET revoked_at = now()
       WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL
       RETURNING id`,
      [keyId, id],
    )
    if (result.rows.length === 0) {
      const existing = await pool.query('SELECT 1 FROM api_keys WHERE id = $1 AND tenant_id = $2', [
        keyId,
        id,
      ])
      if (existing.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'API key not found')
      // already revoked: treat revocation as idempotent
    }
    res.status(204).end()
  })

  return router
}
