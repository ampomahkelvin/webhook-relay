import type { Pool } from 'pg'
import type { DeliveryStatus } from './vocabulary.js'

/**
 * The `deliveries` table's queries and row shape (DESIGN sections 5/7/10).
 * Every consumer of a delivery row — the api routes, the dispatcher's
 * details fetch, the metrics gauges — sources its column knowledge here.
 * Deliveries belong to events, so tenant scope is a join away, not a
 * per-query convention.
 */

export interface DeliveryRow {
  id: string
  event_id: string
  endpoint_id: string
  status: DeliveryStatus
  attempt_count: number
  cycle_start: number
  next_attempt_at: Date
  locked_until: Date | null
  completed_at: Date | null
  created_at: Date
}

/** The row shape used by every plain `SELECT` over `deliveries`. */
const DELIVERY_COLUMNS = `
  d.id, d.event_id, d.endpoint_id, d.status::text AS status, d.attempt_count,
  d.cycle_start, d.next_attempt_at, d.locked_until, d.completed_at, d.created_at`

export interface AttemptRow {
  attempt_number: number
  started_at: Date
  duration_ms: number
  status_code: number | null
  error_kind: string | null
  response_snippet: string | null
}

export interface ListDeliveriesFilters {
  endpointId?: string
  status?: DeliveryStatus
  eventId?: string
}

export async function listDeliveryPage(
  pool: Pool,
  args: { tenantId: string; cursor?: { createdAt: string; id: string } | null; limit: number; filters?: ListDeliveriesFilters },
): Promise<DeliveryRow[]> {
  const { endpointId, status, eventId } = args.filters ?? {}
  const result = await pool.query<DeliveryRow>(
    `SELECT ${DELIVERY_COLUMNS}
     FROM deliveries d
     JOIN events e ON e.id = d.event_id
     WHERE e.tenant_id = $1
       AND ($2::timestamptz IS NULL OR (d.created_at, d.id) < ($2::timestamptz, $3::uuid))
       AND ($4::uuid IS NULL OR d.endpoint_id = $4::uuid)
       AND ($5::delivery_status IS NULL OR d.status = $5::delivery_status)
       AND ($6::uuid IS NULL OR d.event_id = $6::uuid)
     ORDER BY d.created_at DESC, d.id DESC
     LIMIT $7`,
    [
      args.tenantId,
      args.cursor?.createdAt ?? null,
      args.cursor?.id ?? null,
      endpointId ?? null,
      status ?? null,
      eventId ?? null,
      args.limit + 1,
    ],
  )
  return result.rows
}

export async function getDelivery(
  pool: Pool,
  args: { deliveryId: string; tenantId: string },
): Promise<DeliveryRow | null> {
  const result = await pool.query<DeliveryRow>(
    `SELECT ${DELIVERY_COLUMNS}
     FROM deliveries d
     JOIN events e ON e.id = d.event_id
     WHERE d.id = $1 AND e.tenant_id = $2`,
    [args.deliveryId, args.tenantId],
  )
  return result.rows[0] ?? null
}

export async function listAttempts(pool: Pool, deliveryId: string): Promise<AttemptRow[]> {
  const result = await pool.query<AttemptRow>(
    `SELECT attempt_number, started_at, duration_ms, status_code, error_kind,
            response_snippet
     FROM delivery_attempts
     WHERE delivery_id = $1
     ORDER BY attempt_number`,
    [deliveryId],
  )
  return result.rows
}

/** Every delivery of one event, oldest first (the event detail view). */
export async function listDeliveriesForEvent(
  pool: Pool,
  args: { tenantId: string; eventId: string },
): Promise<DeliveryRow[]> {
  const result = await pool.query<DeliveryRow>(
    `SELECT ${DELIVERY_COLUMNS}
     FROM deliveries d
     JOIN events e ON e.id = d.event_id
     WHERE d.event_id = $1 AND e.tenant_id = $2
     ORDER BY d.created_at`,
    [args.eventId, args.tenantId],
  )
  return result.rows
}

interface DeliveryStateShape {
  status: string
  locked_until: Date | null
}

/** Read a delivery's settle state without owning it (why a replay was refused). */
async function findDeliveryState(pool: Pool, args: { deliveryId: string; tenantId: string }): Promise<DeliveryStateShape | null> {
  const result = await pool.query<DeliveryStateShape>(
    `SELECT d.status::text AS status, d.locked_until
     FROM deliveries d
     JOIN events e ON e.id = d.event_id
     WHERE d.id = $1 AND e.tenant_id = $2`,
    [args.deliveryId, args.tenantId],
  )
  return result.rows[0] ?? null
}

/**
 * Replay ONE settled delivery back onto the queue (DESIGN section 10):
 * status pending, due now, lease cleared, and `cycle_start =
 * attempt_count` so the retry schedule restarts at index 0 WITHOUT
 * renumbering the attempt history — the same convention the dispatcher's
 * claim increments and the schedule indexes against. Settlement only: a
 * leased or pending delivery returns as refused, not replayed.
 */
export type ReplayOutcome =
  | { ok: true; delivery: DeliveryRow }
  | { ok: false; state: DeliveryStateShape | null }

export async function replayDelivery(
  pool: Pool,
  args: { deliveryId: string; tenantId: string },
): Promise<ReplayOutcome> {
  const result = await pool.query<DeliveryRow>(
    `UPDATE deliveries d
     SET status = 'pending', next_attempt_at = now(), completed_at = NULL,
         locked_until = NULL, cycle_start = d.attempt_count
     FROM events e
     WHERE d.id = $1 AND e.id = d.event_id AND e.tenant_id = $2
       AND d.status IN ('dead', 'succeeded')
       AND d.locked_until IS NULL
     RETURNING ${DELIVERY_COLUMNS}`,
    [args.deliveryId, args.tenantId],
  )
  const row = result.rows[0]
  if (row) return { ok: true, delivery: row }
  return { ok: false, state: await findDeliveryState(pool, args) }
}
