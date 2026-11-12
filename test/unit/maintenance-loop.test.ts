import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { runMaintenanceLoop } from '../../src/maintenance/sweep.js'

/**
 * I7 regression: the between-sweeps sleep used to be one uninterruptible
 * wait of up to the full interval (60 s in production) — a SIGTERM waited
 * it out while Docker sent SIGKILL after 10 s. The sleep is abortable now:
 * the loop must end within about a second of the stop signal, whatever
 * the interval.
 */

const brokenPool = {
  connect: () => Promise.reject(new Error('no database in this test')),
} as unknown as Pool

describe('runMaintenanceLoop shutdown', () => {
  it('stops within a second of an aborted signal, even with a 60 s interval', async () => {
    const controller = new AbortController()
    const errors: unknown[] = []
    const startedAt = Date.now()
    const running = runMaintenanceLoop(brokenPool, {
      retentionDays: 30,
      deliveryMaxAgeHours: 72,
      autoDisableAfterDays: 5,
      intervalMs: 60_000,
      signal: controller.signal,
      onError: (error) => errors.push(error),
    })

    // The first sweep fails fast (no DB), then the loop sleeps the interval.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(errors.length).toBeGreaterThanOrEqual(1)

    controller.abort()
    await Promise.race([
      running,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('maintenance loop did not stop within 1 s')), 1_000),
      ),
    ])
    expect(Date.now() - startedAt).toBeLessThan(1_500)
  })

  it('honors a shouldStop predicate between sweeps without a signal', async () => {
    let stopping = false
    const running = runMaintenanceLoop(brokenPool, {
      retentionDays: 30,
      deliveryMaxAgeHours: 72,
      autoDisableAfterDays: 5,
      intervalMs: 60_000,
      shouldStop: () => stopping,
    })
    setTimeout(() => {
      stopping = true
    }, 50)
    // The loop must not sit out the 60 s interval before noticing.
    await Promise.race([
      running,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('shouldStop not honored promptly')), 1_000),
      ),
    ])
  })
})
