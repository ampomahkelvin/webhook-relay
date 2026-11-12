import type { Pool, PoolClient } from 'pg'
import { setTimeout as abortableSleep } from 'node:timers/promises'

/**
 * Maintenance operations (DESIGN sections 3/7):
 *
 *  - **Retention pruning:** events older than `retentionDays` are deleted;
 *    their deliveries and attempt logs cascade. The idempotency window for
 *    intake equals the retention window.
 *  - **Expiry sweep:** pending deliveries older than `deliveryMaxAgeHours`
 *    become `dead` (reason banished to the attempt log only), so a
 *    breaker-blocked or disabled endpoint cannot hold deliveries forever.
 *  - **Auto-disable:** an endpoint disabled while `failing_since` is older
 *    than `autoDisableAfterDays` (`disabled_reason: 'failing'`) so its
 *    pending deliveries stay unclaimed until a human re-enables it.
 *
 * Every cycle runs under a session-level advisory lock, so only ONE
 * maintenance process works at a time; the others skip the tick silently.
 */

export interface MaintenanceConfig {
  retentionDays: number
  deliveryMaxAgeHours: number
  autoDisableAfterDays: number
}

export interface SweepOptions extends MaintenanceConfig {
  /** Injectable clock for deterministic cutoffs in tests. */
  nowMs?: number
  /**
   * Retention batch size (I8): events are deleted in bounded chunks so a
   * large backlog (first run after enabling retention, or after a long
   * downtime) cannot become one huge DELETE holding locks and bloating
   * tables. Default 5,000.
   */
  retentionBatchSize?: number
}

export interface SweepResult {
  /** True when THIS invocation held the advisory lock and swept. */
  swept: boolean
  eventsDeleted: number
  deliveriesExpired: number
  endpointsDisabled: number
}

/** Rows per retention DELETE; each batch is its own transaction (I8). */
const DEFAULT_RETENTION_BATCH = 5_000

/** Constant across the codebase so any instance competes for the same lock. */
export const MAINTENANCE_LOCK_ID = 781_207_442

const IDLE: Omit<SweepResult, 'swept'> = {
  eventsDeleted: 0,
  deliveriesExpired: 0,
  endpointsDisabled: 0,
}

export async function runMaintenanceSweep(pool: Pool, options: SweepOptions): Promise<SweepResult> {
  const nowMs = options.nowMs ?? Date.now()
  const retentionCutoff = new Date(nowMs - options.retentionDays * 86_400_000)
  const expiryCutoff = new Date(nowMs - options.deliveryMaxAgeHours * 3_600_000)
  const disableCutoff = new Date(nowMs - options.autoDisableAfterDays * 86_400_000)
  const batchSize = options.retentionBatchSize ?? DEFAULT_RETENTION_BATCH

  const client = await pool.connect()
  let locked = false
  try {
    const acquired = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [MAINTENANCE_LOCK_ID],
    )
    locked = acquired.rows[0]!.locked
    if (!locked) return { swept: false, ...IDLE }

    // Each sweep runs in its OWN transaction (I8): a huge prune can no
    // longer share a transaction with (and hold locks under) the expiry
    // and auto-disable sweeps. The advisory lock is session-level, so it
    // spans the commits; an error mid-prune leaves earlier batches
    // deleted, which is the correct direction for retention.
    const eventsDeleted = await pruneOldEvents(client, retentionCutoff, batchSize)
    const deliveriesExpired = await expireStaleDeliveries(client, expiryCutoff)
    const endpointsDisabled = await disableFailingEndpoints(client, disableCutoff)
    return { swept: true, eventsDeleted, deliveriesExpired, endpointsDisabled }
  } catch (error) {
    if (locked) await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1)', [MAINTENANCE_LOCK_ID]).catch(() => {})
    }
    client.release()
  }
}

/** DELETE the events (and cascaded deliveries + attempts) older than the cutoff, in bounded batches. */
async function pruneOldEvents(
  client: PoolClient,
  cutoff: Date,
  batchSize: number,
): Promise<number> {
  let deleted = 0
  for (;;) {
    await client.query('BEGIN')
    try {
      // Batched by id: each statement removes at most `batchSize` events
      // (their deliveries and attempt logs cascade within the same
      // statement), so every transaction stays bounded.
      const pruned = await client.query<{ count: string }>(
        `WITH batch AS (
           SELECT id FROM events WHERE created_at < $1 LIMIT $2 FOR UPDATE SKIP LOCKED
         )
         DELETE FROM events e
         WHERE e.id IN (SELECT id FROM batch)
         RETURNING 1 AS count`,
        [cutoff, batchSize],
      )
      const batchDeleted = pruned.rows.length
      await client.query('COMMIT')
      deleted += batchDeleted
      if (batchDeleted < batchSize) return deleted
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    }
  }
}

/**
 * The expiry sweep (DESIGN section 3/7): pending deliveries older than
 * the max age become `dead`. The CHECK (pending ⇔ completed_at IS NULL)
 * means an expiry writes completed_at in the same breath as the status.
 * One bounded statement; the attempt log is untouched (append-only).
 */
async function expireStaleDeliveries(client: PoolClient, cutoff: Date): Promise<number> {
  await client.query('BEGIN')
  try {
    const expired = await client.query<{ count: string }>(
      `UPDATE deliveries SET status = 'dead', completed_at = now()
       WHERE status = 'pending' AND created_at < $1 RETURNING id`,
      [cutoff],
    )
    await client.query('COMMIT')
    return expired.rows.length
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}

/**
 * Auto-disable (DESIGN section 7): an endpoint whose failure predates the
 * threshold is disabled with reason `failing` so its pending deliveries
 * stay unclaimed until a human re-enables it.
 */
async function disableFailingEndpoints(client: PoolClient, cutoff: Date): Promise<number> {
  await client.query('BEGIN')
  try {
    const disabled = await client.query<{ count: string }>(
      `UPDATE endpoints
       SET status = 'disabled', disabled_reason = 'failing', updated_at = now()
       WHERE status = 'enabled'
         AND failing_since IS NOT NULL
         AND failing_since < $1
       RETURNING id`,
      [cutoff],
    )
    await client.query('COMMIT')
    return disabled.rows.length
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}

export interface MaintenanceLoopOptions extends SweepOptions {
  /** Sweep interval; every cycle re-competes for the advisory lock. */
  intervalMs: number
  /** Injectable stop signal. */
  shouldStop?: () => boolean
  /**
   * Abort signal for the between-sweeps sleep (I7): without it a stop
   * request waits out a full interval (up to a minute) before the loop
   * notices; with it the sleep wakes immediately.
   */
  signal?: AbortSignal
  onSweep?: (result: SweepResult) => void
  /** Called with every sweep failure so an entrypoint can log it. */
  onError?: (error: unknown) => void
}

/**
 * The maintenance loop for the entrypoint: sweep immediately (so a fresh
 * instance works at once), then every interval. Errors never kill the
 * process — the next tick retries — and each failure goes to `onError`.
 */
export async function runMaintenanceLoop(
  pool: Pool,
  options: MaintenanceLoopOptions,
): Promise<void> {
  const shouldStop = options.shouldStop ?? (() => false)
  const { signal } = options

  const sleep = async (ms: number): Promise<void> => {
    if (signal !== undefined) {
      try {
        await abortableSleep(ms, undefined, { signal })
      } catch {
        // Aborted: the stop check below ends the loop.
      }
      return
    }
    // No signal: slice the sleep so a shouldStop predicate is honored
    // within the slice, not after a whole interval.
    const sliceMs = Math.min(ms, 250)
    for (let waited = 0; waited < ms; waited += sliceMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, sliceMs))
      if (shouldStop()) return
    }
  }

  for (;;) {
    if (shouldStop() || signal?.aborted === true) return
    try {
      const result = await runMaintenanceSweep(pool, options)
      if (result.swept) {
        options.onSweep?.(result)
      }
    } catch (error) {
      options.onError?.(error)
    }
    await sleep(options.intervalMs)
  }
}
