import type { PoolClient } from 'pg'
import type { ApiKeyRowShape, TenantRowShape } from '../api/serialize.js'

/**
 * The `tenants` and `api_keys` tables' queries: the admin namespace's
 * data access. Keys are SHA-256 hashes and are handled by
 * `src/auth/api-keys.ts`; this module persists and lists rows only.
 */

export { type ApiKeyRowShape as ApiKeyRow, type TenantRowShape as TenantRow } from '../api/serialize.js'

/** Anything that can run a query: the pool or a transaction's client. */
type Queryable = Pick<PoolClient, 'query'>

export async function createTenant(db: Queryable, name: string): Promise<TenantRowShape> {
  const result = await db.query<TenantRowShape>(
    'INSERT INTO tenants (name) VALUES ($1) RETURNING id, name, created_at',
    [name],
  )
  const row = result.rows[0]
  if (!row) throw new Error('tenant insert returned no row')
  return row
}

export async function getTenant(db: Queryable, tenantId: string): Promise<TenantRowShape | null> {
  const result = await db.query<TenantRowShape>(
    'SELECT id, name, created_at FROM tenants WHERE id = $1',
    [tenantId],
  )
  return result.rows[0] ?? null
}

export async function listTenants(db: Queryable, limit = 100): Promise<TenantRowShape[]> {
  const result = await db.query<TenantRowShape>(
    'SELECT id, name, created_at FROM tenants ORDER BY created_at DESC LIMIT $1',
    [limit],
  )
  return result.rows
}

export async function insertApiKey(
  db: Queryable,
  tenantId: string,
  keyHash: Buffer,
  keyPrefix: string,
): Promise<string> {
  const result = await db.query<{ id: string }>(
    'INSERT INTO api_keys (tenant_id, key_hash, key_prefix) VALUES ($1, $2, $3) RETURNING id',
    [tenantId, keyHash, keyPrefix],
  )
  const id = result.rows[0]?.id
  if (!id) throw new Error('api key insert returned no row')
  return id
}

export async function listApiKeys(db: Queryable, tenantId: string): Promise<ApiKeyRowShape[]> {
  const result = await db.query<ApiKeyRowShape>(
    'SELECT id, key_prefix, created_at, revoked_at FROM api_keys WHERE tenant_id = $1 ORDER BY created_at',
    [tenantId],
  )
  return result.rows
}

export type RevokeOutcome = 'revoked' | 'already_revoked' | 'not_found'

export async function revokeApiKey(
  db: Queryable,
  args: { tenantId: string; keyId: string },
): Promise<RevokeOutcome> {
  const result = await db.query<{ id: string }>(
    `UPDATE api_keys SET revoked_at = now()
     WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [args.keyId, args.tenantId],
  )
  if (result.rows.length > 0) return 'revoked'
  const existing = await db.query('SELECT 1 FROM api_keys WHERE id = $1 AND tenant_id = $2', [
    args.keyId,
    args.tenantId,
  ])
  return existing.rows.length === 0 ? 'not_found' : 'already_revoked'
}
