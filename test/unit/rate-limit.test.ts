import { describe, expect, it } from 'vitest'
import { TokenBucket } from '../../src/api/rate-limit.js'

describe('TokenBucket', () => {
  it('allows the initial burst then denies', () => {
    const clock = 0
    const bucket = new TokenBucket(3, 60, () => clock)

    expect(bucket.tryTake('t1').allowed).toBe(true)
    expect(bucket.tryTake('t1').allowed).toBe(true)
    expect(bucket.tryTake('t1').allowed).toBe(true)
    expect(bucket.tryTake('t1').allowed).toBe(false)
  })

  it('is per-key', () => {
    const clock = 0
    const bucket = new TokenBucket(1, 0, () => clock)
    expect(bucket.tryTake('a').allowed).toBe(true)
    expect(bucket.tryTake('b').allowed).toBe(true)
    expect(bucket.tryTake('a').allowed).toBe(false)
  })

  it('reports Retry-After proportional to the missing tokens', () => {
    let clock = 0
    // refill 60/min = 1 token per second
    const bucket = new TokenBucket(2, 60, () => clock)
    bucket.tryTake('k')
    bucket.tryTake('k')
    const verdict = bucket.tryTake('k')
    expect(verdict.allowed).toBe(false)
    expect(verdict.retryAfterSeconds).toBe(1)

    clock = 500 // half a second: half a token
    expect(bucket.tryTake('k').allowed).toBe(false)
    clock = 1000
    expect(bucket.tryTake('k').allowed).toBe(true)
  })

  it('never reports a retry sooner than 1 second', () => {
    const clock = 0
    // refill 6000/min = 100 tokens/s: a deficit costs only 10 ms
    const bucket = new TokenBucket(1, 6000, () => clock)
    bucket.tryTake('k')
    const verdict = bucket.tryTake('k')
    expect(verdict.allowed).toBe(false)
    expect(verdict.retryAfterSeconds).toBeGreaterThanOrEqual(1)
  })

  it('caps Retry-After when refill is zero', () => {
    const clock = 0
    const bucket = new TokenBucket(1, 0, () => clock)
    bucket.tryTake('k')
    const verdict = bucket.tryTake('k')
    expect(verdict.allowed).toBe(false)
    expect(verdict.retryAfterSeconds).toBe(60)
  })

  it('refills up-front but not beyond capacity', () => {
    let clock = 0
    const bucket = new TokenBucket(5, 600, () => clock) // 10 tokens/s
    bucket.tryTake('k')
    bucket.tryTake('k')
    clock = 60_000 * 20 // plenty of time: bucket refills to capacity (5)
    // capacity is the hard ceiling even after a long idle period
    const verdicts = Array.from({ length: 6 }, () => bucket.tryTake('k').allowed)
    expect(verdicts).toEqual([true, true, true, true, true, false])
  })
})
