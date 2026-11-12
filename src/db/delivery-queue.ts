/**
 * The delivery queue's data access (DESIGN sections 6.1–6.4, 7): claiming
 * with leases, the delivery details read model, and recording attempt
 * outcomes with fencing + the breaker step + the 410 auto-disable. All of
 * the queue's SQL lives here; the dispatcher owns no statements.
 */

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

import type { Pool, PoolClient, QueryResult } from 'pg'
import { nextOnFailure, CLOSED_BREAKER, type BreakerSnapshot } from '../domain/breaker.js'

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
               d.next_attempt_at,
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
       -- Oldest due first ACROSS endpoints too (I3): id is a random UUID,
       -- so ordering by it chose endpoints at random whenever the backlog
       -- exceeded the batch, letting a long-overdue delivery wait behind
       -- newer ones.
       ORDER BY next_attempt_at, id
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

/**
 * Recording an attempt's outcome with fencing (DESIGN section 6.4), plus
 * the breaker step and the `410` endpoint disable (DESIGN section 7), all
 * in ONE short transaction:
 *
 *  - the attempt log is append-only: even a fenced worker's row is written,
 *  - the delivery UPDATE applies only while the delivery still has exactly
 *    the attempt this worker claimed and is still pending — otherwise this
 *    worker is STALE and must not touch the delivery, the breaker, or the
 *    endpoint,
 *  - the breaker transitions are computed by the pure functions in
 *    `domain/breaker.ts`; a healthy success (closed, zero failures) writes
 *    nothing (the write-amplification rule): the success path is ONE
 *    conditional UPDATE whose WHERE matches only an unhealthy row — a
 *    non-matching WHERE acquires no row lock, so concurrent completions
 *    for a busy endpoint never queue on it (I1),
 *  - failures take the read-and-compute path: they need the live snapshot
 *    to decide the transition, so they hold the row lock briefly.
 */

export type SendOutcome = 'succeeded' | 'dead' | 'retry'

export interface RecordParams {
  deliveryId: string
  /** The endpoint this delivery points at; breaker + 410 handling need it. */
  endpointId: string
  /** The `attempt_count` this worker claimed; the fencing token. */
  claimedAttempt: number
  outcome: SendOutcome
  /** Why an outcome is `dead`; drives the `gone` endpoint auto-disable. */
  deadReason?: 'gone' | 'schedule_exhausted'
  /** Next claim time for retries; ignored otherwise. */
  nextAttemptAtMs?: number
  startedAtMs: number
  durationMs: number
  statusCode?: number
  errorKind?: string
  /**
   * The response snippet as a storage-safe string (already sanitized by
   * `toSnippet` in send.ts: valid UTF-8, no NUL). Sliced to the column's
   * 1,024-character CHECK here as well, so an oversized caller degrades to
   * a short snippet instead of a failed record.
   */
  responseSnippet?: string
  /** Consecutive-failure count that opens the breaker. */
  breakerThreshold: number
  /**
   * The clock for breaker timestamps and `completed_at`; defaults to the
   * process clock. Injected so tests control all time — and so, one day,
   * every writer can take it from the database's clock instead (I2).
   */
  nowMs?: number
}

export type RecordResult = { applied: true } | { applied: false; stale: true }

export async function recordAttempt(pool: Pool, params: RecordParams): Promise<RecordResult> {
  const {
    deliveryId,
    endpointId,
    claimedAttempt,
    outcome,
    deadReason,
    nextAttemptAtMs,
    startedAtMs,
    durationMs,
    statusCode,
    errorKind,
    responseSnippet,
    breakerThreshold,
    nowMs = Date.now(),
  } = params

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // The attempt log is append-only: even a fenced attempt happened.
    await client.query(
      `INSERT INTO delivery_attempts
         (delivery_id, attempt_number, started_at, duration_ms, status_code, error_kind, response_snippet)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (delivery_id, attempt_number) DO NOTHING`,
      [
        deliveryId,
        claimedAttempt,
        new Date(startedAtMs),
        Math.max(0, Math.min(durationMs, 2_147_483_647)),
        statusCode ?? null,
        errorKind ?? null,
        responseSnippet !== undefined ? responseSnippet.slice(0, 1024) : null,
      ],
    )

    const isPending = outcome === 'retry'
    // 'retry' is a dispatcher-side outcome; the delivery stays 'pending'
    // until it goes to the endpoint again. `next_attempt_at` is NOT NULL,
    // so terminal outcomes keep the last value (the due index only reads
    // pending rows, so the stale value is harmless).
    const status = isPending ? 'pending' : outcome
    const deliveryUpdate = await client.query(
      `UPDATE deliveries
       SET status = $2::delivery_status,
           next_attempt_at = $3,
           locked_until = NULL,
           completed_at = $4
       WHERE id = $1
         AND attempt_count = $5
         AND status = 'pending'`,
      [
        deliveryId,
        status,
        isPending ? new Date(nextAttemptAtMs ?? 0) : new Date(nowMs),
        isPending ? null : new Date(nowMs),
        claimedAttempt,
      ],
    )
    if (deliveryUpdate.rowCount === 0) {
      await client.query('COMMIT')
      return { applied: false, stale: true }
    }

    if (outcome === 'succeeded') {
      // I1 — the write-amplification rule as ONE statement: it touches
      // nothing when the endpoint is already healthy, and a non-matching
      // WHERE takes no row lock, so concurrent completions for the same
      // busy endpoint never queue on it. Failures keep the
      // read-and-compute path below (they need the live snapshot).
      await client.query(
        `UPDATE endpoints
         SET circuit_state = 'closed', consecutive_failures = 0,
             failing_since = NULL, circuit_opened_at = NULL
         WHERE id = $1 AND (circuit_state <> 'closed' OR consecutive_failures > 0)`,
        [endpointId],
      )
    } else {
      const snapshot = await readBreakerForUpdate(client, endpointId)
      const transition = nextOnFailure(snapshot, nowMs, breakerThreshold)
      if (transition.write) {
        // failing_since stays the FIRST failure's time (COALESCE).
        await client.query(
          `UPDATE endpoints
           SET circuit_state = $2, consecutive_failures = $3,
               failing_since = COALESCE(failing_since, $4),
               circuit_opened_at = $5
           WHERE id = $1`,
          [
            endpointId,
            transition.next.circuit,
            transition.next.consecutiveFailures,
            new Date(nowMs),
            transition.next.openedAtMs !== null ? new Date(transition.next.openedAtMs) : null,
          ],
        )
      }
    }

    if (deadReason === 'gone') {
      // 410: the receiver said this webhook destination is gone for good.
      // Disable once; pending deliveries of it stay pending until the
      // expiry sweep or human re-enable.
      await client.query(
        `UPDATE endpoints
         SET status = 'disabled', disabled_reason = 'gone'
         WHERE id = $1 AND status = 'enabled'`,
        [endpointId],
      )
    }

    await client.query('COMMIT')
    return { applied: true }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** Read the endpoint's breaker state with the row locked until commit. */
async function readBreakerForUpdate(
  client: PoolClient,
  endpointId: string,
): Promise<BreakerSnapshot> {
  const result = await client.query<{
    circuit_state: string
    consecutive_failures: number
    circuit_opened_at: Date | null
  }>(
    `SELECT circuit_state::text, consecutive_failures, circuit_opened_at
     FROM endpoints WHERE id = $1 FOR UPDATE`,
    [endpointId],
  )
  const row = result.rows[0]
  if (row === undefined) return CLOSED_BREAKER // deleted under us: nothing to write into
  return {
    circuit: row.circuit_state as BreakerSnapshot['circuit'],
    consecutiveFailures: row.consecutive_failures,
    openedAtMs: row.circuit_opened_at?.getTime() ?? null,
  }
}
