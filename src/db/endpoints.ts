import type { Pool } from 'pg'
import type { CircuitState, DisabledReason, EndpointStatus } from './vocabulary.js'

/**
 * The `endpoints` table's queries. Every statement carries the tenant
 * scope in its WHERE clause — this file is the one place that states how
 * an endpoint is owned, and no caller re-implements the guard.
 */

export interface EndpointRow {
  id: string
  tenant_id: string
  url: string
  description: string | null
  event_types: string[]
  status: EndpointStatus
  disabled_reason: DisabledReason | null
  circuit_state: CircuitState
  created_at: Date
  updated_at: Date
}

const ENDPOINT_COLUMNS = `
  id, tenant_id, url, description, event_types, status, disabled_reason,
  circuit_state, created_at, updated_at`

export async function createEndpoint(
  pool: Pool,
  args: {
    tenantId: string
    url: string
    description: string | null
    eventTypes: string[]
    secretCiphertext: Buffer
    /** Cap enforcement: the insert only happens while this holds. */
    maxPerTenant: number
  },
): Promise<EndpointRow | null> {
  // Atomic cap link: the INSERT only happens while the count is below the
  // limit, so intake fan-out stays bounded (DESIGN section 4).
  const result = await pool.query<EndpointRow>(
    `INSERT INTO endpoints (tenant_id, url, description, event_types, secret_ciphertext)
     SELECT $1, $2, $3, $4::text[], $5
     WHERE (SELECT count(*) FROM endpoints WHERE tenant_id = $1) < $6
     RETURNING ${ENDPOINT_COLUMNS}`,
    [
      args.tenantId,
      args.url,
      args.description,
      args.eventTypes,
      args.secretCiphertext,
      args.maxPerTenant,
    ],
  )
  return result.rows[0] ?? null
}

export async function getOwnedEndpoint(
  pool: Pool,
  args: { tenantId: string; endpointId: string },
): Promise<EndpointRow | null> {
  const result = await pool.query<EndpointRow>(
    `SELECT ${ENDPOINT_COLUMNS}
     FROM endpoints
     WHERE id = $1 AND tenant_id = $2`,
    [args.endpointId, args.tenantId],
  )
  return result.rows[0] ?? null
}

export async function listEndpointPage(
  pool: Pool,
  args: { tenantId: string; cursor?: { createdAt: string; id: string } | null; limit: number },
): Promise<EndpointRow[]> {
  const result = await pool.query<EndpointRow>(
    `SELECT ${ENDPOINT_COLUMNS}
     FROM endpoints
     WHERE tenant_id = $1
       AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
     ORDER BY created_at DESC, id DESC
     LIMIT $4`,
    [args.tenantId, args.cursor?.createdAt ?? null, args.cursor?.id ?? null, args.limit + 1],
  )
  return result.rows
}

export interface EndpointPatch {
  url: string
  description: string | null
  eventTypes: string[]
  status: EndpointStatus
  /** The CHECK constraint requires a reason whenever status is 'disabled'. */
  disabledReason: DisabledReason | null
}

export async function updateEndpoint(
  pool: Pool,
  args: { tenantId: string; endpointId: string; patch: EndpointPatch },
): Promise<EndpointRow> {
  const result = await pool.query<EndpointRow>(
    `UPDATE endpoints
     SET url = $1, description = $2, event_types = $3::text[], status = $4,
         disabled_reason = $5, updated_at = now()
     WHERE id = $6 AND tenant_id = $7
     RETURNING ${ENDPOINT_COLUMNS}`,
    [
      args.patch.url,
      args.patch.description,
      args.patch.eventTypes,
      args.patch.status,
      args.patch.disabledReason,
      args.endpointId,
      args.tenantId,
    ],
  )
  const row = result.rows[0]
  if (!row) throw new Error('endpoint update did not apply to an owned row')
  return row
}

export async function deleteEndpoint(
  pool: Pool,
  args: { tenantId: string; endpointId: string },
): Promise<void> {
  // Deliveries for this endpoint cascade-delete (DESIGN section 10).
  await pool.query('DELETE FROM endpoints WHERE id = $1 AND tenant_id = $2', [
    args.endpointId,
    args.tenantId,
  ])
}
