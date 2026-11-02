import type { Pool, PoolClient } from 'pg'
import {
  nextOnFailure,
  nextOnSuccess,
  CLOSED_BREAKER,
  type BreakerSnapshot,
} from '../domain/breaker.js'

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
 *    nothing (the write-amplification rule).
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
  responseSnippet?: Buffer
  /** Consecutive-failure count that opens the breaker. */
  breakerThreshold: number
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
        responseSnippet !== undefined ? responseSnippet.subarray(0, 1024) : null,
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
        isPending ? new Date(nextAttemptAtMs ?? 0) : new Date(startedAtMs),
        isPending ? null : new Date(),
        claimedAttempt,
      ],
    )
    if (deliveryUpdate.rowCount === 0) {
      await client.query('COMMIT')
      return { applied: false, stale: true }
    }

    if (outcome === 'succeeded') {
      const snapshot = await readBreakerForUpdate(client, endpointId)
      const transition = nextOnSuccess(snapshot)
      if (transition.write) {
        await client.query(
          `UPDATE endpoints
           SET circuit_state = $2, consecutive_failures = $3,
               failing_since = NULL, circuit_opened_at = NULL
           WHERE id = $1`,
          [endpointId, transition.next.circuit, transition.next.consecutiveFailures],
        )
      }
    } else {
      const snapshot = await readBreakerForUpdate(client, endpointId)
      const transition = nextOnFailure(snapshot, Date.now(), breakerThreshold)
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
            new Date(),
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
