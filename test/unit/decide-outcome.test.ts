import { describe, expect, it } from 'vitest'
import {
  MAX_ATTEMPTS_PER_CYCLE,
  STANDARD_RETRY_DELAYS_MS,
} from '../../src/domain/retry-schedule.js'
import { decideOutcome } from '../../src/dispatcher/decide-outcome.js'
import type { AttemptSent } from '../../src/dispatcher/send.js'
import type { ClaimedDelivery, DeliveryDetails } from '../../src/db/delivery-queue.js'

const NOW = 1_700_000_000_000

const claimed: ClaimedDelivery = {
  id: 'd1',
  eventId: 'e1',
  endpointId: 'ep1',
  attemptNumber: 3,
  probe: false,
}

const details: DeliveryDetails = {
  deliveryId: 'd1',
  attemptNumber: 3,
  eventId: 'e1',
  eventType: 'test',
  payload: {},
  eventCreatedAt: new Date(0),
  endpointUrl: 'https://example.com/hook',
  secretCiphertext: Buffer.alloc(0),
  cycleStart: 0,
}

const sent = (outcome: AttemptSent['outcome'], startedAtMs = NOW): AttemptSent => ({
  outcome,
  startedAtMs,
  durationMs: 10,
})

const retryable = sent({ kind: 'retry', errorKind: 'connection' })

describe('decideOutcome', () => {
  it('a success records succeeded', () => {
    expect(decideOutcome(claimed, details, sent({ kind: 'succeeded' }))).toEqual({
      kind: 'succeeded',
    })
  })

  it('a 410 is dead with reason gone (endpoint auto-disable)', () => {
    expect(decideOutcome(claimed, details, sent({ kind: 'gone' }))).toEqual({
      kind: 'dead',
      reason: 'gone',
    })
  })

  it('a retryable failure schedules from the send clock within the jitter bounds', () => {
    const decided = decideOutcome(claimed, details, retryable)
    // Attempt 3 of the cycle → the 3rd standard delay, jittered ±20%.
    const base = STANDARD_RETRY_DELAYS_MS[2]!
    expect(decided.kind).toBe('retry')
    if (decided.kind !== 'retry') return
    expect(decided.nextAttemptAtMs).toBeGreaterThanOrEqual(NOW + base * 0.8)
    expect(decided.nextAttemptAtMs).toBeLessThan(NOW + base * 1.2)
  })

  it('a single-delay override applies to the first attempt of a cycle', () => {
    // rng still jitters, so pin via the bounds of the one configured delay.
    const first: ClaimedDelivery = { ...claimed, attemptNumber: 1 }
    const decided = decideOutcome(first, details, retryable, [2_000])
    expect(decided.kind).toBe('retry')
    if (decided.kind !== 'retry') return
    expect(decided.nextAttemptAtMs).toBeGreaterThanOrEqual(NOW + 1_600)
    expect(decided.nextAttemptAtMs).toBeLessThan(NOW + 2_400)
  })

  it(`schedule exhaustion (attempt ${MAX_ATTEMPTS_PER_CYCLE} of the cycle) is dead with reason schedule_exhausted`, () => {
    const exhausted: ClaimedDelivery = { ...claimed, attemptNumber: MAX_ATTEMPTS_PER_CYCLE }
    expect(decideOutcome(exhausted, details, retryable)).toEqual({
      kind: 'dead',
      reason: 'schedule_exhausted',
    })
  })

  it('Retry-After can postpone but never shorten the schedule', () => {
    const first: ClaimedDelivery = { ...claimed, attemptNumber: 1 }
    const decided = decideOutcome(
      first,
      details,
      sent({ kind: 'retry', errorKind: 'connection', retryAfterSeconds: 900 }),
      [1_000],
    )
    expect(decided).toEqual({ kind: 'retry', nextAttemptAtMs: NOW + 900_000 })
  })

  it('dead decisions never carry a next attempt time', () => {
    for (const decision of [
      decideOutcome(claimed, details, sent({ kind: 'gone' })),
      decideOutcome({ ...claimed, attemptNumber: MAX_ATTEMPTS_PER_CYCLE }, details, retryable),
    ]) {
      expect(decision.kind).toBe('dead')
      expect('nextAttemptAtMs' in decision).toBe(false)
    }
  })
})
