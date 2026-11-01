import type { Pool } from 'pg'

/**
 * Recording an attempt's outcome with fencing (DESIGN section 6.4). The
 * result UPDATE only applies while the delivery still has exactly the
 * attempt this worker claimed and is still pending; otherwise this worker
 * is STALE (its lease expired and another dispatcher claimed a newer
 * attempt, or a replay restarted the cycle). A stale worker's attempt row
 * is still written — that request really happened — but it must not touch
 * the delivery.
 */

export type SendOutcome = 'succeeded' | 'dead' | 'retry'

export interface RecordParams {
  deliveryId: string
  /** The `attempt_count` this worker claimed; the fencing token. */
  claimedAttempt: number
  outcome: SendOutcome
  /** Next claim time for retries; ignored otherwise. */
  nextAttemptAtMs?: number
  startedAtMs: number
  durationMs: number
  statusCode?: number
  errorKind?: string
  responseSnippet?: Buffer
}

export type RecordResult = { applied: true } | { applied: false; stale: true }

export async function recordAttempt(pool: Pool, params: RecordParams): Promise<RecordResult> {
  const {
    deliveryId,
    claimedAttempt,
    outcome,
    nextAttemptAtMs,
    startedAtMs,
    durationMs,
    statusCode,
    errorKind,
    responseSnippet,
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
    const update = await client.query(
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
    if (update.rowCount === 0) {
      await client.query('COMMIT')
      return { applied: false, stale: true }
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
