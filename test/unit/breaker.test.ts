import { describe, expect, it } from 'vitest'
import {
  CLOSED_BREAKER,
  nextOnFailure,
  nextOnSuccess,
  type BreakerSnapshot,
} from '../../src/domain/breaker.js'

const NOW = 1_700_000_000_000
const THRESHOLD = 5

const closed = (failures = 0): BreakerSnapshot => ({
  circuit: 'closed',
  consecutiveFailures: failures,
  openedAtMs: null,
})

describe('nextOnFailure', () => {
  it('keeps a closed breaker closed and counts below the threshold', () => {
    const transition = nextOnFailure(closed(2), NOW, THRESHOLD)
    expect(transition.write).toBe(true)
    expect(transition.next).toEqual({
      circuit: 'closed',
      consecutiveFailures: 3,
      openedAtMs: null,
    })
  })

  it('opens the breaker exactly at the threshold (5th consecutive failure)', () => {
    const transition = nextOnFailure(closed(4), NOW, THRESHOLD)
    expect(transition.next.circuit).toBe('open')
    expect(transition.next.consecutiveFailures).toBe(5)
    expect(transition.next.openedAtMs).toBe(NOW)
  })

  it('the first failure starts the failing_since clock in the caller (0 failures today)', () => {
    const transition = nextOnFailure(CLOSED_BREAKER, NOW, THRESHOLD)
    expect(transition.next.consecutiveFailures).toBe(1)
    expect(transition.next.circuit).toBe('closed')
    // openedAtMs stays null: the circuit did not open; the caller takes
    // COALESCE(failing_since, now()) for the health clock.
  })

  it('a failing probe reopens with a FRESH cooldown', () => {
    const opened: BreakerSnapshot = {
      circuit: 'half_open',
      consecutiveFailures: 5,
      openedAtMs: NOW - 61_000, // a stale half-open probe
    }
    const transition = nextOnFailure(opened, NOW, THRESHOLD)
    expect(transition.next).toEqual({
      circuit: 'open',
      consecutiveFailures: 6,
      openedAtMs: NOW,
    })
  })

  it('a failure on an already-open breaker leaves the cooldown untouched', () => {
    const opened: BreakerSnapshot = {
      circuit: 'open',
      consecutiveFailures: 7,
      openedAtMs: NOW - 10_000,
    }
    const transition = nextOnFailure(opened, NOW, THRESHOLD)
    expect(transition.next.circuit).toBe('open')
    expect(transition.next.openedAtMs).toBe(NOW - 10_000)
    expect(transition.next.consecutiveFailures).toBe(8)
  })
})

describe('nextOnSuccess', () => {
  it('a healthy success (closed, zero failures) writes NOTHING', () => {
    const transition = nextOnSuccess(CLOSED_BREAKER)
    expect(transition.write).toBe(false)
    expect(transition.next).toEqual({ ...CLOSED_BREAKER })
  })

  it('a success after failures clears the counters and closes', () => {
    const transition = nextOnSuccess(closed(2))
    expect(transition.write).toBe(true)
    expect(transition.next).toEqual({
      circuit: 'closed',
      consecutiveFailures: 0,
      openedAtMs: null,
    })
  })

  it('a probe success closes the breaker and clears everything', () => {
    const halfOpen: BreakerSnapshot = {
      circuit: 'half_open',
      consecutiveFailures: 6,
      openedAtMs: NOW - 5_000,
    }
    const transition = nextOnSuccess(halfOpen)
    expect(transition.write).toBe(true)
    expect(transition.next).toEqual({
      circuit: 'closed',
      consecutiveFailures: 0,
      openedAtMs: null,
    })
  })

  it('a successor failure count cannot survive a success (no stale counters)', () => {
    // threshold 1: a single failure opens immediately
    expect(nextOnFailure(CLOSED_BREAKER, NOW, 1).next.circuit).toBe('open')
    // and the very next success closes it again
    expect(
      nextOnSuccess({ circuit: 'open', consecutiveFailures: 1, openedAtMs: NOW }).next.circuit,
    ).toBe('closed')
  })
})
