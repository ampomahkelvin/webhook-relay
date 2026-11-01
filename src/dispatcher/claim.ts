import type { Pool } from 'pg'
import type { QueryResult } from 'pg'

/**
 * Claiming due deliveries with leases (DESIGN section 6.1). One statement,
 * no transaction held during a send:
 *
 *  - `ranked` orders claimable rows per endpoint, capped per endpoint
 *    (fairness — a backlog on one endpoint cannot starve the others).
 *  - The outer UPDATE re-checks the lease condition and uses
 *    `FOR UPDATE SKIP LOCKED`, so concurrent dispatchers claim disjoint
 *    sets.
 *  - `attempt_count` is incremented at claim time: the claimed value is
 *    this attempt's identity and the fencing token.
 *  - `now`, `lease`, and `cooldown` are injected (not `now()` in SQL) so
 *    tests can advance time deterministically without real sleeps.
 */

export interface ClaimOptions {
  nowMs: number
  /** Claim at most this many deliveries. */
  batchSize: number
  /** Fairness cap: at most this many per endpoint per batch. */
  perEndpointClaimCap: number
  /** Lease length: the send timeout plus a margin. */
  leaseSeconds: number
  /** Open breakers before their cooldown passes are not claimable. */
  breakerCooldownSeconds: number
}

export interface ClaimedDelivery {
  id: string
  eventId: string
  endpointId: string
  attemptNumber: number
}

export async function claimDueDeliveries(
  pool: Pool,
  options: ClaimOptions,
): Promise<ClaimedDelivery[]> {
  const { nowMs, batchSize, perEndpointClaimCap, leaseSeconds, breakerCooldownSeconds } = options
  const now = new Date(nowMs)
  const leaseUntil = new Date(nowMs + leaseSeconds * 1000)

  const result: QueryResult<{
    id: string
    event_id: string
    endpoint_id: string
    attempt_count: number
  }> = await pool.query(
    `WITH ranked AS (
        SELECT d.id,
               row_number() OVER (
                 PARTITION BY d.endpoint_id
                 ORDER BY d.next_attempt_at, d.id
               ) AS rn
        FROM deliveries d
        JOIN endpoints e ON e.id = d.endpoint_id
        WHERE d.status = 'pending'
          AND d.next_attempt_at <= $1
          AND (d.locked_until IS NULL OR d.locked_until < $1)
          AND e.status = 'enabled'
          AND (e.circuit_state = 'closed'
               OR (e.circuit_state = 'open'
                   AND e.circuit_opened_at + make_interval(secs => $2::int) <= $1))
     ),
     picked AS (
       SELECT id FROM ranked WHERE rn <= $3 ORDER BY id LIMIT $4
     )
     UPDATE deliveries d
     SET locked_until  = $5,
         attempt_count = d.attempt_count + 1
     FROM (
       SELECT id FROM deliveries
       WHERE id IN (SELECT id FROM picked)
         AND status = 'pending'
         AND (locked_until IS NULL OR locked_until < $1)
       FOR UPDATE SKIP LOCKED
     ) c
     WHERE d.id = c.id
     RETURNING d.id, d.event_id, d.endpoint_id, d.attempt_count`,
    [now, breakerCooldownSeconds, perEndpointClaimCap, batchSize, leaseUntil],
  )
  return result.rows.map((row) => ({
    id: row.id,
    eventId: row.event_id,
    endpointId: row.endpoint_id,
    attemptNumber: row.attempt_count,
  }))
}

export interface DeliveryDetails {
  deliveryId: string
  attemptNumber: number
  eventId: string
  eventType: string
  payload: unknown
  eventCreatedAt: Date
  endpointUrl: string
  secretCiphertext: Buffer
  /** `attempt_count` at the last (re)start; the schedule index is attemptNumber - cycleStart. */
  cycleStart: number
}

/**
 * Everything a send needs: the event (id, type, payload, creation) and the
 * endpoint's URL plus the encrypted signing secret, decrypted just in time
 * by the sender.
 */
export async function fetchDeliveryDetails(
  pool: Pool,
  ids: readonly string[],
): Promise<Map<string, DeliveryDetails>> {
  if (ids.length === 0) return new Map()
  const result = await pool.query<{
    id: string
    attempt_count: number
    cycle_start: number
    event_id: string
    event_type: string
    payload: unknown
    event_created_at: Date
    url: string
    secret_ciphertext: Buffer
  }>(
    `SELECT d.id, d.attempt_count, d.cycle_start, e.id AS event_id, e.event_type, e.payload,
            e.created_at AS event_created_at, ep.url, ep.secret_ciphertext
     FROM deliveries d
     JOIN events e ON e.id = d.event_id
     JOIN endpoints ep ON ep.id = d.endpoint_id
     WHERE d.id = ANY ($1::uuid[])`,
    [ids as unknown as string[]],
  )
  const map = new Map<string, DeliveryDetails>()
  for (const row of result.rows) {
    map.set(row.id, {
      deliveryId: row.id,
      attemptNumber: row.attempt_count,
      cycleStart: row.cycle_start,
      eventId: row.event_id,
      eventType: row.event_type,
      payload: row.payload,
      eventCreatedAt: row.event_created_at,
      endpointUrl: row.url,
      secretCiphertext: row.secret_ciphertext,
    })
  }
  return map
}
