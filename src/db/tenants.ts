import type { PoolClient } from 'pg'

/**
 * The `tenants` and `api_keys` tables' queries and row shapes: the admin
 * namespace's data access. Keys are SHA-256 hashes and are handled by
 * `src/auth/api-keys.ts`; this module persists, looks up, and lists rows
 * only.
 */

export interface TenantRow {
  id: string
  name: string
  created_at: Date
}

export interface ApiKeyRow {
  id: string
  key_prefix: string
  created_at: Date
  revoked_at: Date | null
}

/** Anything that can run a query: the pool or a transaction's client. */
type Queryable = Pick<PoolClient, 'query'>

export async function createTenant(db: Queryable, name: string): Promise<TenantRow> {
  const result = await db.query<TenantRow>(
    'INSERT INTO tenants (name) VALUES ($1) RETURNING id, name, created_at',
    [name],
  )
  const row = result.rows[0]
  if (!row) throw new Error('tenant insert returned no row')
  return row
}

export async function getTenant(db: Queryable, tenantId: string): Promise<TenantRow | null> {
  const result = await db.query<TenantRow>(
    'SELECT id, name, created_at FROM tenants WHERE id = $1',
    [tenantId],
  )
  return result.rows[0] ?? null
}

export async function listTenants(db: Queryable, limit = 100): Promise<TenantRow[]> {
  const result = await db.query<TenantRow>(
    'SELECT id, name, created_at FROM tenants ORDER BY created_at DESC LIMIT $1',
    [limit],
  )
  return result.rows
}

/**
 * The tenant owning an UNREVOKED key. Resolving a bearer token to its
 * tenant is one join, and it reads the api_keys table, so it belongs here
 * — `src/auth/tenant-auth.ts` hashes the presented key and calls this.
 */
export async function findTenantByKeyHash(
  db: Queryable,
  keyHash: Buffer,
): Promise<TenantRow | null> {
  const result = await db.query<TenantRow>(
    `SELECT t.id, t.name, t.created_at
     FROM api_keys k
     JOIN tenants t ON t.id = k.tenant_id
     WHERE k.key_hash = $1 AND k.revoked_at IS NULL
     LIMIT 1`,
    [keyHash],
  )
  return result.rows[0] ?? null
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

export async function listApiKeys(db: Queryable, tenantId: string): Promise<ApiKeyRow[]> {
  const result = await db.query<ApiKeyRow>(
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
