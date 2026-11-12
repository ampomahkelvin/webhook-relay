import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { recordAttempt } from '../../src/db/delivery-queue.js'
import { startTestDatabase, type TestDatabase } from '../helpers/test-db.js'
import { seedWorkload, type SeedWorkload } from '../helpers/seed.js'

/**
 * I1 regression: `recordAttempt` used to run
 * `SELECT ... FROM endpoints WHERE id = $1 FOR UPDATE` on EVERY outcome,
 * including success — so concurrent completions for one busy endpoint
 * queued on that row even when nothing needed writing. The success path is
 * now one conditional UPDATE whose WHERE matches only an unhealthy row; a
 * non-matching WHERE acquires no row lock. While another transaction holds
 * the endpoint row, successes must still commit immediately.
 */

const T0 = new Date('2026-03-01T08:00:00.000Z').getTime()

describe('a healthy success never waits on the endpoint row (I1)', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db.stop()
  })

  it('50 parallel successes commit while the endpoint row is locked elsewhere', async () => {
    const workload: SeedWorkload = await seedWorkload(db.pool, {
      count: 50,
      endpointUrl: 'http://localhost:9/never',
    })
    const ids = workload.deliveryIds
    await db.pool.query(
      `UPDATE deliveries SET attempt_count = 1, locked_until = now() + interval '60 seconds'
       WHERE endpoint_id = $1`,
      [workload.endpointId],
    )

    // Hold the endpoint row in another transaction (as a failure recorder
    // would during its read-and-compute path).
    const holder = await db.pool.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM endpoints WHERE id = $1 FOR UPDATE', [workload.endpointId])

      const startedAt = Date.now()
      const results = await Promise.race([
        Promise.all(
          ids.map((deliveryId) =>
            recordAttempt(db.pool, {
              deliveryId,
              endpointId: workload.endpointId,
              breakerThreshold: 5,
              claimedAttempt: 1,
              outcome: 'succeeded',
              startedAtMs: T0,
              durationMs: 5,
              statusCode: 200,
              nowMs: T0,
            }),
          ),
        ),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('successes blocked on the endpoint row')), 10_000),
        ),
      ])
      expect(results.every((r) => r.applied)).toBe(true)
      // Generous, but far under the 10 s a blocked row lock would cost
      // (the old code failed this race by hanging on the FOR UPDATE).
      expect(Date.now() - startedAt).toBeLessThan(5_000)

      await holder.query('COMMIT')
    } catch (error) {
      await holder.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      holder.release()
    }

    const done = await db.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM deliveries
       WHERE endpoint_id = $1 AND status = 'succeeded'`,
      [workload.endpointId],
    )
    expect(Number(done.rows[0]!.n)).toBe(50)
    // The endpoint stays healthy — the conditional UPDATE had nothing to do.
    const endpoint = await db.pool
      .query<{ circuit_state: string; consecutive_failures: number }>(
        `SELECT circuit_state::text, consecutive_failures FROM endpoints WHERE id = $1`,
        [workload.endpointId],
      )
      .then((r) => r.rows[0]!)
    expect(endpoint.circuit_state).toBe('closed')
    expect(endpoint.consecutive_failures).toBe(0)
  })

  it('a success still resets an unhealthy endpoint (half-open probe closes it)', async () => {
    const workload = await seedWorkload(db.pool, {
      count: 1,
      endpointUrl: 'http://localhost:9/never',
    })
    const deliveryId = workload.deliveryIds[0]!
    await db.pool.query(
      `UPDATE deliveries SET attempt_count = 1, locked_until = now() + interval '60 seconds'
       WHERE endpoint_id = $1`,
      [workload.endpointId],
    )
    await db.pool.query(
      `UPDATE endpoints SET circuit_state = 'open', consecutive_failures = 5,
              failing_since = $2, circuit_opened_at = $3
       WHERE id = $1`,
      [workload.endpointId, new Date(T0 - 60_000), new Date(T0 - 60_000)],
    )

    const result = await recordAttempt(db.pool, {
      deliveryId,
      endpointId: workload.endpointId,
      breakerThreshold: 5,
      claimedAttempt: 1,
      outcome: 'succeeded',
      startedAtMs: T0,
      durationMs: 10,
      statusCode: 200,
      nowMs: T0,
    })
    expect(result).toEqual({ applied: true })

    const endpoint = await db.pool
      .query<{ circuit_state: string; consecutive_failures: number; failing_since: Date | null }>(
        `SELECT circuit_state::text, consecutive_failures, failing_since
         FROM endpoints WHERE id = $1`,
        [workload.endpointId],
      )
      .then((r) => r.rows[0]!)
    expect(endpoint.circuit_state).toBe('closed')
    expect(endpoint.consecutive_failures).toBe(0)
    expect(endpoint.failing_since).toBeNull()
  })
})
