import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { canonicalJson } from '../util/canonical-json.js'

/**
 * The `events` table's queries and writer conventions (DESIGN section 5).
 * Everything that makes an event an event — the canonical content hash,
 * the idempotent intake statement, the read side — lives here, so nothing
 * outside this file hand-rolls event SQL.
 */

export interface EventRow {
  id: string
  event_type: string
  payload: unknown
  idempotency_key: string
  created_at: Date
}

/**
 * The request-hash convention: sha256 over the canonical
 * `{eventType, payload}` object. Replay detection compares these hashes,
 * so every event writer (intake and the endpoint test-send) must use this
 * exact formula.
 */
export function requestHash(eventType: string, payload: unknown): Buffer {
  return createHash('sha256').update(canonicalJson({ eventType, payload }), 'utf8').digest()
}

export interface EventReplay {
  eventId: string
  deliveries: number
  requestHash: Buffer
}

interface IntakeResultRow {
  new_event_id: string | null
  new_deliveries: string // bigint comes back as string
  replay_event_id: string | null
  replay_deliveries: string | null
  replay_hash: Buffer | null
}

/**
 * Idempotent intake: the event and one delivery per matching enabled
 * endpoint are created in ONE statement — a producer retry either sees a
 * fresh insert or, after blocking on the unique index, the committed
 * original, never a partial event or a lost fan-out.
 */
export async function submitIntake(
  pool: Pool,
  args: {
    tenantId: string
    eventType: string
    payloadJson: string
    idempotencyKey: string
  },
): Promise<{ result: IntakeResultRow | null }> {
  // The hash is a property of the event's content, so the writer derives
  // it here — callers cannot mint a differently-computed one.
  const hash = requestHash(args.eventType, JSON.parse(args.payloadJson))
  const result = await pool.query<IntakeResultRow>(
    `WITH ev AS (
       INSERT INTO events (tenant_id, event_type, payload, idempotency_key, request_hash)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING id
     ),
     existing AS (
       SELECT e.id AS event_id,
              e.request_hash,
              (SELECT count(*) FROM deliveries d WHERE d.event_id = e.id) AS deliveries
       FROM events e
       WHERE e.tenant_id = $1 AND e.idempotency_key = $4 AND NOT EXISTS (SELECT 1 FROM ev)
     ),
     fresh AS (
       INSERT INTO deliveries (event_id, endpoint_id)
       SELECT ev.id, ep.id
       FROM ev
       JOIN endpoints ep ON ep.tenant_id = $1
        AND ep.status = 'enabled'
        AND ('*' = ANY(ep.event_types) OR $2 = ANY(ep.event_types))
       RETURNING 1
     )
     SELECT (SELECT id FROM ev)               AS new_event_id,
            (SELECT count(*) FROM fresh)      AS new_deliveries,
            (SELECT event_id FROM existing)   AS replay_event_id,
            (SELECT deliveries FROM existing) AS replay_deliveries,
            (SELECT request_hash FROM existing) AS replay_hash`,
    [args.tenantId, args.eventType, args.payloadJson, args.idempotencyKey, hash],
  )
  return { result: result.rows[0] ?? null }
}

export async function resolveReplay(
  pool: Pool,
  args: { tenantId: string; idempotencyKey: string },
): Promise<EventReplay | null> {
  const result = await pool.query<{
    id: string
    request_hash: Buffer
    deliveries: string
  }>(
    `SELECT e.id, e.request_hash,
            (SELECT count(*) FROM deliveries d WHERE d.event_id = e.id) AS deliveries
     FROM events e
     WHERE e.tenant_id = $1 AND e.idempotency_key = $2`,
    [args.tenantId, args.idempotencyKey],
  )
  const found = result.rows[0]
  if (!found) return null
  return {
    eventId: found.id,
    deliveries: Number(found.deliveries),
    requestHash: found.request_hash,
  }
}

/** An event is scoped by its own tenant_id; deliveries follow it. */
export async function getEvent(
  pool: Pool,
  args: { eventId: string; tenantId: string },
): Promise<EventRow | null> {
  const result = await pool.query<EventRow>(
    `SELECT e.id, e.event_type, e.payload, e.idempotency_key, e.created_at
     FROM events e
     WHERE e.id = $1 AND e.tenant_id = $2`,
    [args.eventId, args.tenantId],
  )
  return result.rows[0] ?? null
}

/**
 * One event with ONE delivery to a fixed endpoint, committed in a single
 * statement so the event never exists without its delivery (the pattern
 * intake's CTE generalizes to one endpoint). The request hash uses the
 * same content formula as intake (requestHash above) so the two writers
 * cannot encode different meanings into one column.
 */
export async function insertEventWithSingleDelivery(
  pool: Pool,
  args: {
    tenantId: string
    eventType: string
    payloadJson: string
    idempotencyKey: string
    endpointId: string
  },
): Promise<{ eventId: string; deliveryId: string } | null> {
  const hash = requestHash(args.eventType, JSON.parse(args.payloadJson))
  const result = await pool.query<{ event_id: string; delivery_id: string }>(
    `WITH ev AS (
       INSERT INTO events (tenant_id, event_type, payload, idempotency_key, request_hash)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       RETURNING id
     ), del AS (
       INSERT INTO deliveries (event_id, endpoint_id, next_attempt_at)
       SELECT ev.id, $6::uuid, now() FROM ev
       RETURNING id, event_id
     )
     SELECT (SELECT id FROM ev) AS event_id,
            (SELECT id FROM del) AS delivery_id`,
    [args.tenantId, args.eventType, args.payloadJson, args.idempotencyKey, hash, args.endpointId],
  )
  const created = result.rows[0]
  return created ? { eventId: created.event_id, deliveryId: created.delivery_id } : null
}
