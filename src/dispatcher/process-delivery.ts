import type { Pool } from '../db/pool.js'
import type { ClaimedDelivery } from '../db/delivery-claim.js'
import type { DeliveryDetails } from '../db/delivery-details.js'
import { recordAttempt, type RecordOutcome } from '../db/delivery-record.js'
import type { Logger } from '../logger.js'
import { sendDeliveryAttempt } from './send.js'
import { decideOutcome, statsKeyOf } from './decide-outcome.js'
import type { DispatcherConfig, DispatcherMetrics, DispatcherStats } from './ports.js'

/** Backoffs between record retries (C1); injectable for tests. */
export const RECORD_BACKOFF_MS: readonly number[] = [250, 1_000, 4_000]

/**
 * One delivery's worker (`process-delivery.ts`): send once, decide the
 * outcome, record it with fencing. Extracted from the loop so the
 * no-resend-on-record-failure rule (C1) is testable in isolation; the
 * loop supplies the mutable stats, the stop predicate, and a raceable
 * sleep, and owns the queue otherwise.
 */
export interface ProcessDeliveryDeps {
  pool: Pool
  config: DispatcherConfig
  logger: Logger
  /** Shared counters, owned by the loop and mutated here. */
  stats: DispatcherStats
  isStopping: () => boolean
  /** Raceable idle sleep that honors stop (used between record retries). */
  sleep: (ms: number) => Promise<void>
  metrics?: DispatcherMetrics
  /** Overrides the default record-retry backoffs (tests). */
  recordBackoffMs?: readonly number[]
}

export function createProcessDelivery(
  deps: ProcessDeliveryDeps,
): (claimed: ClaimedDelivery, details: DeliveryDetails | undefined) => Promise<void> {
  const { pool, config, logger, stats, metrics } = deps

  /**
   * Record ONE attempt result. A recording failure is NOT a send failure:
   * the receiver has already answered (possibly acted on the webhook), so
   * re-sending now would double-deliver. The record is idempotent (fenced
   * by `attempt_count`), so retry it briefly with backoff; if it still
   * fails, leave the lease to expire — the delivery is re-claimed only
   * after the lease is long gone, which is the legitimate at-least-once
   * path, not an immediate re-send.
   */
  async function recordWithRetries(
    claimed: ClaimedDelivery,
    decided: RecordOutcome,
    sent: Awaited<ReturnType<typeof sendDeliveryAttempt>>,
  ): Promise<void> {
    // A FRESH budget per delivery (N1): a shared array would be consumed
    // by the first deliveries to hit a record failure, leaving every later
    // one to give up immediately and wait out the whole lease.
    const waits = [...(deps.recordBackoffMs ?? RECORD_BACKOFF_MS)]
    for (;;) {
      try {
        const recorded = await recordAttempt(pool, {
          deliveryId: claimed.id,
          endpointId: claimed.endpointId,
          breakerThreshold: config.breakerThreshold,
          claimedAttempt: claimed.attemptNumber,
          attempt: {
            startedAtMs: sent.startedAtMs,
            durationMs: sent.durationMs,
            statusCode: sent.statusCode,
            errorKind: sent.errorKind,
            responseSnippet: sent.snippet,
          },
          outcome: decided,
          // Same clock as the send: breaker timestamps and completed_at
          // must not drift from the attempt they belong to (I2).
          nowMs: sent.startedAtMs + sent.durationMs,
        })
        if (!recorded.applied) {
          // Stale: the lease expired and a newer attempt exists. The attempt
          // log row stands; the delivery state belongs to the newer attempt.
          stats.stale++
          logger.info(
            { deliveryId: claimed.id, attempt: claimed.attemptNumber },
            'stale worker: result not applied',
          )
        } else {
          stats[statsKeyOf(decided)]++
          if (metrics) {
            metrics.attemptDuration(sent.durationMs / 1_000)
            metrics.deliveryOutcome(decided.kind)
          }
        }
        return
      } catch (error) {
        const waitMs = waits.shift()
        if (waitMs === undefined || deps.isStopping()) {
          logger.error(
            {
              deliveryId: claimed.id,
              attempt: claimed.attemptNumber,
              err: (error as Error).message,
            },
            'recording the attempt failed; leaving the lease to expire (no re-send)',
          )
          return
        }
        logger.warn(
          { deliveryId: claimed.id, err: (error as Error).message },
          'recording the attempt failed; retrying the record',
        )
        await deps.sleep(waitMs)
      }
    }
  }

  return async function processDelivery(
    claimed: ClaimedDelivery,
    details: DeliveryDetails | undefined,
  ): Promise<void> {
    try {
      if (details === undefined) {
        // The delivery vanished under us (event or endpoint deleted —
        // cascade). Leave the lease to expire; nothing to record.
        stats.sends++
        return
      }
      let sent: Awaited<ReturnType<typeof sendDeliveryAttempt>>
      try {
        sent = await sendDeliveryAttempt(details, config)
      } catch (error) {
        // `sendDeliveryAttempt` is total (it classifies every failure
        // internally); reaching here is a programming error. Treat it like
        // a transport failure recorded on the schedule, not a crash.
        logger.error({ deliveryId: claimed.id, err: (error as Error).message }, 'send threw')
        sent = {
          outcome: { kind: 'retry', errorKind: 'connection' },
          startedAtMs: Date.now(),
          durationMs: 0,
        }
      }
      stats.sends++
      if (sent.internalError) {
        logger.warn(
          { deliveryId: claimed.id, reason: sent.internalError },
          'attempt failed before reaching the wire',
        )
      }

      const decided = decideOutcome(claimed, details, sent, config.delaysMs)
      await recordWithRetries(claimed, decided, sent)
    } catch (error) {
      // Nothing above throws by design; this is the last-resort net so one
      // worker's failure can never take the dispatcher down. The lease is
      // left to expire (no blind re-send, no bypass of the schedule).
      logger.error({ deliveryId: claimed.id, err: (error as Error).message }, 'worker error')
    }
  }
}
