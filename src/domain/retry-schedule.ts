/**
 * The retry schedule (DESIGN section 6.3): attempts at roughly
 * `0, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h` — 8 attempts in total,
 * about 28 hours — each delay jittered ±20%, after which the delivery is
 * `dead`. Pure, clock-injectable; the delay array is injectable so tests
 * can run a doomed delivery to `dead` in milliseconds instead of a day.
 */

/** Delay AFTER the previous failed attempt ended. Index `n` applies after attempt `n` (1-based within cycle) */
export const STANDARD_RETRY_DELAYS_MS = [
  5_000, // after attempt 1
  5 * 60_000, // attempt 2
  30 * 60_000, // attempt 3
  2 * 3_600_000, // attempt 4
  5 * 3_600_000, // attempt 5
  10 * 3_600_000, // attempt 6
  10 * 3_600_000, // attempt 7
] as const

export const MAX_ATTEMPTS_PER_CYCLE = 8
const JITTER = 0.2

export type RetryOutcome = 'retry' | 'dead'

export interface ScheduleInput {
  /** The attempt that just failed: `attempt_count - cycle_start` (1-based). */
  attemptNumber: number
  /** Same clock the result was recorded with, ms epoch. */
  nowMs: number
  /** Classifier's `Retry-After` cap in seconds (already capped at 1 h). */
  retryAfterSeconds?: number
  /** Random in [0,1); injectable for exact jitter bounds in tests. */
  rng?: () => number
  /** Delay schedule override; defaults to the standard 7 delays. */
  delaysMs?: readonly number[]
}

export type ScheduleDecision =
  | { outcome: 'dead'; reason: 'schedule_exhausted' }
  | {
      outcome: 'retry'
      /** Always at least now + jittered delay; never earlier than a Retry-After. */
      nextAttemptAtMs: number
      delayMs: number
    }

function jittered(delayMs: number, rng: () => number): number {
  const factor = 1 + (2 * rng() - 1) * JITTER // uniform in [0.8, 1.2)
  return delayMs * factor
}

/**
 * Decide what follows the failed attempt `attemptNumber` of the current
 * cycle. The schedule never ties the next attempt to the delivery's
 * creation time: processing time (slow receiver, GC pause, database
 * contention) must not shrink the gaps into a retry storm — each delay
 * starts from when the attempt was recorded.
 */
export function scheduleNext(input: ScheduleInput): ScheduleDecision {
  const { attemptNumber, nowMs, retryAfterSeconds, rng = Math.random } = input
  const delays = input.delaysMs ?? STANDARD_RETRY_DELAYS_MS

  if (attemptNumber >= MAX_ATTEMPTS_PER_CYCLE) {
    return { outcome: 'dead', reason: 'schedule_exhausted' }
  }

  const baseDelay = delays[attemptNumber - 1]
  if (baseDelay === undefined) {
    // More attempts configured than the schedule supports: dead.
    return { outcome: 'dead', reason: 'schedule_exhausted' }
  }
  const delay = jittered(baseDelay, rng)
  let nextAttemptAtMs = nowMs + delay
  if (retryAfterSeconds !== undefined) {
    // Retry-After can postpone but never shorten the schedule.
    nextAttemptAtMs = Math.max(nextAttemptAtMs, nowMs + retryAfterSeconds * 1000)
  }
  return { outcome: 'retry', nextAttemptAtMs, delayMs: nextAttemptAtMs - nowMs }
}
