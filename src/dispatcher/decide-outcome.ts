import type { ClaimedDelivery, DeliveryDetails, RecordOutcome } from '../db/delivery-queue.js'
import { scheduleNext } from '../domain/retry-schedule.js'
import type { AttemptSent } from './send.js'

/**
 * The outcome decision (`decide-outcome.ts`): PURE per DESIGN — a sent
 * attempt in, the outcome to record out. No clock, no stats, no database,
 * so every rule (410 → dead/gone, schedule exhaustion → dead) is testable
 * without Postgres.
 */

/** The stats key an outcome feeds, so stats and metrics move together. */
export function statsKeyOf(outcome: RecordOutcome): 'succeeded' | 'retried' | 'dead' {
  return outcome.kind === 'succeeded' ? 'succeeded' : outcome.kind === 'dead' ? 'dead' : 'retried'
}

export function decideOutcome(
  claimed: ClaimedDelivery,
  details: DeliveryDetails,
  sent: AttemptSent,
  delaysMs?: readonly number[],
): RecordOutcome {
  if (sent.outcome.kind === 'succeeded') {
    return { kind: 'succeeded' }
  }
  if (sent.outcome.kind === 'gone') {
    // 410: the receiver declared the destination gone for good.
    return { kind: 'dead', reason: 'gone' }
  }
  const scheduled = scheduleNext({
    attemptNumber: claimed.attemptNumber - details.cycleStart,
    nowMs: sent.startedAtMs,
    retryAfterSeconds: sent.outcome.kind === 'retry' ? sent.outcome.retryAfterSeconds : undefined,
    delaysMs,
  })
  if (scheduled.outcome === 'dead') {
    return { kind: 'dead', reason: 'schedule_exhausted' }
  }
  return { kind: 'retry', nextAttemptAtMs: scheduled.nextAttemptAtMs }
}
