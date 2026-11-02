import type { Pool, PoolClient } from 'pg'
import type { QueryResult } from 'pg'

/**
 * Claiming due deliveries with leases (DESIGN section 6.1 + 7), one short
 * transaction per claim batch, never held during a send:
 *
 *  - `ranked` orders claimable rows per endpoint so a backlog on one
 *    endpoint cannot starve the others; leases already in flight count
 *    against the endpoint's capacity (they are subtracted from the cap).
 *  - Breaker `closed` endpoints claim up to the per-endpoint cap; an
 *    `open`/`half_open` endpoint past its cooldown gets EXACTLY ONE row —
 *    the probe — and moves to `half_open` in the same transaction.
 *  - The outer UPDATE re-checks the lease condition and uses
 *    `FOR UPDATE SKIP LOCKED`, so concurrent dispatchers claim disjoint
 *    sets; the endpoint transition re-checks the live circuit state, so a
 *    probe a colleague already closed never re-opens it.
 *  - `attempt_count` is incremented at claim time: the claimed value is
 *    this attempt's identity and the fencing token.
 *  - `now`, `lease`, and `cooldown` are injected (not `now()` in SQL) so
 *    tests can advance time deterministically without real sleeps.
 */

export interface ClaimOptions {
  nowMs: number
  /** Claim at most this many deliveries across all endpoints. */
  batchSize: number
  /** Fairness cap: at most this many per endpoint per batch (closed breakers). */
  perEndpointClaimCap: number
  /** Lease length: the send timeout plus a margin. */
  leaseSeconds: number
  /** Cooldown before an open breaker may be probed, or a half-open one re-probed. */
  breakerCooldownSeconds: number
}

export interface ClaimedDelivery {
  id: string
  eventId: string
  endpointId: string
  attemptNumber: number
  /** True when this claim is its endpoint's post-cooldown probe. */
  probe: boolean
}

export async function claimDueDeliveries(
  pool: Pool,
  options: ClaimOptions,
): Promise<ClaimedDelivery[]> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const claimed = await claimOn(client, options)
    await client.query('COMMIT')
    return claimed
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    return await Promise.reject(error)
  } finally {
    client.release()
  }
}

async function claimOn(client: PoolClient, options: ClaimOptions): Promise<ClaimedDelivery[]> {
  const { nowMs, batchSize, perEndpointClaimCap, leaseSeconds, breakerCooldownSeconds } = options
  const now = new Date(nowMs)
  const leaseUntil = new Date(nowMs + leaseSeconds * 1000)

  const result: QueryResult<{
    id: string
    event_id: string
    endpoint_id: string
    attempt_count: number
    probe: boolean
  }> = await client.query(
    `WITH inflight AS (
        SELECT endpoint_id, count(*)::int AS n
        FROM deliveries
        WHERE status = 'pending' AND locked_until > $1
        GROUP BY endpoint_id
     ),
     ranked AS (
        SELECT d.id,
               d.endpoint_id,
               row_number() OVER (
                 PARTITION BY d.endpoint_id
                 ORDER BY d.next_attempt_at, d.id
               ) AS rn,
               CASE
                 WHEN e.circuit_state = 'closed'
                   THEN GREATEST($3::int - COALESCE(i.n, 0), 0)
                 ELSE GREATEST(1 - COALESCE(i.n, 0), 0)  -- a probe: one at a time
               END AS claim_limit,
               e.circuit_state <> 'closed' AS probe
        FROM deliveries d
        JOIN endpoints e ON e.id = d.endpoint_id
        LEFT JOIN inflight i ON i.endpoint_id = e.id
        WHERE d.status = 'pending'
          AND d.next_attempt_at <= $1
          AND (d.locked_until IS NULL OR d.locked_until < $1)
          AND e.status = 'enabled'
          AND (e.circuit_state = 'closed'
               OR (e.circuit_state IN ('open', 'half_open')
                   AND e.circuit_opened_at + make_interval(secs => $2::int) <= $1))
     ),
     picked AS (
       SELECT id, endpoint_id, probe
       FROM ranked
       WHERE rn <= claim_limit
       ORDER BY id
       LIMIT $4
     )
     UPDATE deliveries d
     SET locked_until  = $5,
         attempt_count = d.attempt_count + 1
     FROM (
       SELECT p.id, p.endpoint_id, p.probe
       FROM picked p
       JOIN deliveries x ON x.id = p.id
       WHERE x.status = 'pending'
         AND (x.locked_until IS NULL OR x.locked_until < $1)
       FOR UPDATE SKIP LOCKED
     ) c
     WHERE d.id = c.id
     RETURNING d.id, d.event_id, d.endpoint_id, d.attempt_count, c.probe`,
    [now, breakerCooldownSeconds, perEndpointClaimCap, batchSize, leaseUntil],
  )

  const claimed: ClaimedDelivery[] = result.rows.map((row) => ({
    id: row.id,
    eventId: row.event_id,
    endpointId: row.endpoint_id,
    attemptNumber: row.attempt_count,
    probe: row.probe,
  }))

  // The probes leave the breaker in the same transaction as the claim: a
  // crash between the two would leave an open breaker probing nothing.
  // Re-check the live state: if a colleague closed it in the meantime, do
  // not move it back.
  const probeEndpointIds = [...new Set(claimed.filter((c) => c.probe).map((c) => c.endpointId))]
  if (probeEndpointIds.length > 0) {
    await client.query(
      `UPDATE endpoints e
       SET circuit_state = 'half_open', circuit_opened_at = $1
       FROM unnest($2::uuid[]) WITH ORDINALITY AS p(id, ord)
       WHERE e.id = p.id AND e.circuit_state IN ('open', 'half_open')`,
      [now, probeEndpointIds],
    )
  }
  return claimed
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
