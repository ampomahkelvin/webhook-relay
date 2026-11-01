import { describe, expect, it } from 'vitest'
import {
  MAX_ATTEMPTS_PER_CYCLE,
  STANDARD_RETRY_DELAYS_MS,
  scheduleNext,
} from '../../src/domain/retry-schedule.js'

const NOW = 1_700_000_000_000

describe('scheduleNext — standard schedule', () => {
  it('schedules the first retry after the first delay, jitter-neutral with rng 0.5', () => {
    const decision = scheduleNext({ attemptNumber: 1, nowMs: NOW, rng: () => 0.5 })
    expect(decision.outcome).toBe('retry')
    expect(decision.nextAttemptAtMs).toBe(NOW + STANDARD_RETRY_DELAYS_MS[0])
    expect(decision.delayMs).toBe(STANDARD_RETRY_DELAYS_MS[0])
  })

  it('walks the standard delays attempt by attempt', () => {
    for (const [index, delay] of STANDARD_RETRY_DELAYS_MS.entries()) {
      const decision = scheduleNext({ attemptNumber: index + 1, nowMs: NOW, rng: () => 0.5 })
      expect(decision.outcome).toBe('retry')
      expect(decision.delayMs).toBe(delay)
    }
  })

  it('is never tied to creation time: gaps start at record time, processing slack does not shrink them', () => {
    const late = scheduleNext({ attemptNumber: 2, nowMs: NOW + 47_000, rng: () => 0.5 })
    const onTime = scheduleNext({ attemptNumber: 2, nowMs: NOW, rng: () => 0.5 })
    expect(late.delayMs).toBe(onTime.delayMs)
    expect(late.nextAttemptAtMs).toBe(late.nextAttemptAtMs)
    // The gap between attempt time and next attempt is the schedule delay,
    // not (creation + schedule - attempt time).
    expect(late.nextAttemptAtMs! - (NOW + 47_000)).toBe(STANDARD_RETRY_DELAYS_MS[1])
  })
})

describe('scheduleNext — jitter bounds', () => {
  it('rng = 0 gives the lower bound: 80% of the base delay', () => {
    for (const attemptNumber of [1, 2, 3, 7]) {
      const decision = scheduleNext({ attemptNumber, nowMs: NOW, rng: () => 0 })
      expect(decision.delayMs).toBe(STANDARD_RETRY_DELAYS_MS[attemptNumber - 1]! * 0.8)
    }
  })

  it('rng → 1 approaches the upper bound: 120% but never exceeds it', () => {
    const decision = scheduleNext({ attemptNumber: 1, nowMs: NOW, rng: () => 0.999999 })
    const base = STANDARD_RETRY_DELAYS_MS[0]!
    expect(decision.delayMs).toBeLessThan(base * 1.2)
    expect(decision.delayMs).toBeGreaterThan(base * 1.199)
  })

  it('jitter stays within ±20% for many random draws', () => {
    for (let i = 0; i < 200; i++) {
      const decision = scheduleNext({ attemptNumber: 1, nowMs: NOW })
      const base = STANDARD_RETRY_DELAYS_MS[0]!
      expect(decision.delayMs).toBeGreaterThanOrEqual(base * 0.8)
      expect(decision.delayMs).toBeLessThan(base * 1.2)
    }
  })
})

describe('scheduleNext — dead after the cycle limit', () => {
  it(`dies at attempt ${MAX_ATTEMPTS_PER_CYCLE} regardless of the schedule`, () => {
    const decision = scheduleNext({ attemptNumber: MAX_ATTEMPTS_PER_CYCLE, nowMs: NOW })
    expect(decision.outcome).toBe('dead')
    expect(decision.reason).toBe('schedule_exhausted')
    expect(decision.nextAttemptAtMs).toBeUndefined()
  })

  it(`attempt ${MAX_ATTEMPTS_PER_CYCLE - 1} is still retryable`, () => {
    const decision = scheduleNext({ attemptNumber: MAX_ATTEMPTS_PER_CYCLE - 1, nowMs: NOW })
    expect(decision.outcome).toBe('retry')
  })

  it('an empty schedule kills immediately (configured more attempts than delays)', () => {
    const decision = scheduleNext({ attemptNumber: 1, nowMs: NOW, delaysMs: [] })
    expect(decision.outcome).toBe('dead')
  })
})

describe('scheduleNext — Retry-After', () => {
  it('a Retry-After longer than the jittered delay postpones the next attempt', () => {
    const decision = scheduleNext({
      attemptNumber: 1,
      nowMs: NOW,
      retryAfterSeconds: 900,
      rng: () => 0,
    })
    expect(decision.outcome).toBe('retry')
    expect(decision.nextAttemptAtMs).toBe(NOW + 900_000)
  })

  it('a Retry-After can never shorten the schedule', () => {
    const decision = scheduleNext({
      attemptNumber: 1,
      nowMs: NOW,
      retryAfterSeconds: 1,
      rng: () => 0,
    })
    // Jittered base delay (4 s) wins over 1 s.
    expect(decision.nextAttemptAtMs).toBe(NOW + 4_000)
  })

  it('the floor applies at every step, not just the first retry', () => {
    const decision = scheduleNext({
      attemptNumber: 5,
      nowMs: NOW,
      retryAfterSeconds: 3600,
      rng: () => 0,
    })
    const base = STANDARD_RETRY_DELAYS_MS[4]! * 0.8
    expect(decision.nextAttemptAtMs).toBe(NOW + Math.max(base, 3_600_000))
  })

  it('dies even when a Retry-After is present at the attempt limit', () => {
    const decision = scheduleNext({
      attemptNumber: MAX_ATTEMPTS_PER_CYCLE,
      nowMs: NOW,
      retryAfterSeconds: 3600,
    })
    expect(decision.outcome).toBe('dead')
  })
})
