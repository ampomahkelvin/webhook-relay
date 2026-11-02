import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { recordAttempt, type RecordParams } from '../../src/dispatcher/record.js'
import { startTestDatabase, type TestDatabase } from '../helpers/test-db.js'
import { seedWorkload, type SeedWorkload } from '../helpers/seed.js'

/**
 * Recording attempt outcomes with fencing (DESIGN section 6.4): the
 * attempt log is append-only; only the worker that still owns the exact
 * attempt moves the delivery.
 */

const URL = 'http://localhost:9/never'
const T0 = new Date('2026-02-01T09:00:00.000Z').getTime()

interface DeliveryRow {
  status: string
  attempt_count: number
  next_attempt_at: Date
  locked_until: Date | null
  completed_at: Date | null
}

async function loadDelivery(pool: Pool, id: string): Promise<DeliveryRow> {
  const result = await pool.query<DeliveryRow>(
    `SELECT status::text, attempt_count, next_attempt_at, locked_until, completed_at
     FROM deliveries WHERE id = $1`,
    [id],
  )
  return result.rows[0]!
}

async function attemptRow(
  pool: Pool,
  id: string,
  attempt: number,
): Promise<
  | {
      status_code: number | null
      error_kind: string | null
      response_snippet: string | null
      duration_ms: number
    }
  | undefined
> {
  const result = await pool.query(
    `SELECT status_code, error_kind::text, response_snippet, duration_ms
     FROM delivery_attempts WHERE delivery_id = $1 AND attempt_number = $2`,
    [id, attempt],
  )
  return result.rows[0]
}

const T = (offsetMs: number): number => T0 + offsetMs

async function claimedOnce(db: TestDatabase, count = 1): Promise<SeedWorkload> {
  const workload = await seedWorkload(db.pool, { count, endpointUrl: URL })
  // Set the claim state directly (attempt 1, lease held); claiming through
  // claimDueDeliveries is exercised in claim-lease.test.ts. Direct setup
  // isolates each test from leftover due rows of its siblings.
  await db.pool.query(
    `UPDATE deliveries SET attempt_count = 1, locked_until = now() + interval '60 seconds'
     WHERE endpoint_id = $1`,
    [workload.endpointId],
  )
  return workload
}

describe('recordAttempt', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db.stop()
  })

  /** recordAttempt with the endpoint wiring filled in from the workload. */
  function rec(
    workload: SeedWorkload,
    args: Omit<RecordParams, 'endpointId' | 'breakerThreshold'>,
  ) {
    return recordAttempt(db.pool, {
      ...args,
      endpointId: workload.endpointId,
      breakerThreshold: 5,
    })
  }

  it('a success completes the delivery and logs the attempt', async () => {
    const workload = await claimedOnce(db)
    const id = workload.deliveryIds[0]!

    const result = await rec(workload, {
      deliveryId: id,
      claimedAttempt: 1,
      outcome: 'succeeded',
      startedAtMs: T(0),
      durationMs: 140,
      statusCode: 200,
      responseSnippet: Buffer.from('{"received":true}'),
    })
    expect(result).toEqual({ applied: true })

    const row = await loadDelivery(db.pool, id)
    expect(row.status).toBe('succeeded')
    expect(row.completed_at).not.toBeNull()
    expect(row.locked_until).toBeNull()
    const attempt = await attemptRow(db.pool, id, 1)
    expect(attempt?.status_code).toBe(200)
    expect(attempt?.duration_ms).toBe(140)
    expect(attempt?.response_snippet).toBe('{"received":true}')
  })

  it('a retry keeps the delivery pending at the scheduled instant and clears the lease', async () => {
    const workload = await claimedOnce(db)
    const id = workload.deliveryIds[0]!

    const result = await rec(workload, {
      deliveryId: id,
      claimedAttempt: 1,
      outcome: 'retry',
      nextAttemptAtMs: T(5 * 60_000),
      startedAtMs: T(0),
      durationMs: 250,
      statusCode: 500,
      responseSnippet: Buffer.from('boom'),
    })
    expect(result).toEqual({ applied: true })

    const row = await loadDelivery(db.pool, id)
    expect(row.status).toBe('pending')
    expect(row.completed_at).toBeNull()
    expect(row.locked_until).toBeNull()
    expect(row.next_attempt_at.getTime()).toBe(T(5 * 60_000))
    expect((await attemptRow(db.pool, id, 1))?.status_code).toBe(500)
  })

  it('a dead delivery is terminal with a completed_at', async () => {
    const workload = await claimedOnce(db)
    const id = workload.deliveryIds[0]!

    const result = await rec(workload, {
      deliveryId: id,
      claimedAttempt: 1,
      outcome: 'dead',
      startedAtMs: T(0),
      durationMs: 90,
      statusCode: 410,
      responseSnippet: Buffer.from('gone'),
    })
    expect(result).toEqual({ applied: true })
    const row = await loadDelivery(db.pool, id)
    expect(row.status).toBe('dead')
    expect(row.completed_at).not.toBeNull()
    expect(row.locked_until).toBeNull()
  })

  it('stores at most 1 KB of the response snippet', async () => {
    const workload = await claimedOnce(db)
    const id = workload.deliveryIds[0]!
    await rec(workload, {
      deliveryId: id,
      claimedAttempt: 1,
      outcome: 'succeeded',
      startedAtMs: T(0),
      durationMs: 10,
      statusCode: 200,
      responseSnippet: Buffer.alloc(2000, 'x'),
    })
    const attempt = await attemptRow(db.pool, id, 1)
    expect(attempt?.response_snippet?.length).toBe(1024)
  })

  it('write-once semantics: a repeated record for the same attempt does not duplicate the log row', async () => {
    const workload = await claimedOnce(db)
    const id = workload.deliveryIds[0]!
    for (let i = 0; i < 2; i++) {
      await rec(workload, {
        deliveryId: id,
        claimedAttempt: 1,
        outcome: 'retry',
        nextAttemptAtMs: T(60_000),
        startedAtMs: T(0),
        durationMs: 5,
        statusCode: 503,
        responseSnippet: Buffer.from('again'),
      })
    }
    const count = await db.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM delivery_attempts WHERE delivery_id = $1`,
      [id],
    )
    expect(Number(count.rows[0]!.n)).toBe(1)
  })

  describe('fencing', () => {
    it('a stale attempt number is logged but never touches the delivery', async () => {
      const workload = await claimedOnce(db)
      const id = workload.deliveryIds[0]!
      // Another claimer has moved the delivery on to attempt 2 (e.g. the
      // lease expired after a hang) while attempt 1's worker finally
      // reports.
      await db.pool.query(`UPDATE deliveries SET attempt_count = 2 WHERE id = $1`, [id])

      const result = await rec(workload, {
        deliveryId: id,
        claimedAttempt: 1,
        outcome: 'succeeded',
        startedAtMs: T(30_000),
        durationMs: 60,
        statusCode: 200,
      })
      expect(result).toEqual({ applied: false, stale: true })

      // The attempt row stands: that request really happened.
      expect((await attemptRow(db.pool, id, 1))?.status_code).toBe(200)
      // The delivery is untouched.
      const row = await loadDelivery(db.pool, id)
      expect(row.status).toBe('pending')
      expect(row.completed_at).toBeNull()
      expect(row.attempt_count).toBe(2)
    })

    it('the newer attempt still owns the delivery', async () => {
      const workload = await claimedOnce(db)
      const id = workload.deliveryIds[0]!
      await db.pool.query(`UPDATE deliveries SET attempt_count = 2 WHERE id = $1`, [id])
      const fresh = await rec(workload, {
        deliveryId: id,
        claimedAttempt: 2,
        outcome: 'succeeded',
        startedAtMs: T(40_000),
        durationMs: 30,
        statusCode: 204,
      })
      expect(fresh).toEqual({ applied: true })
      expect((await loadDelivery(db.pool, id)).status).toBe('succeeded')
    })

    it('recording a second time is stale after the delivery already moved', async () => {
      const workload = await claimedOnce(db)
      const id = workload.deliveryIds[0]!
      await rec(workload, {
        deliveryId: id,
        claimedAttempt: 1,
        outcome: 'succeeded',
        startedAtMs: T(0),
        durationMs: 5,
        statusCode: 200,
      })
      // Same attempt recorded again: the WHERE status = 'pending' misses.
      const again = await rec(workload, {
        deliveryId: id,
        claimedAttempt: 1,
        outcome: 'retry',
        nextAttemptAtMs: T(120_000),
        startedAtMs: T(10),
        durationMs: 5,
        statusCode: 500,
      })
      expect(again).toEqual({ applied: false, stale: true })
      expect((await loadDelivery(db.pool, id)).status).toBe('succeeded')
      expect((await attemptRow(db.pool, id, 1))?.status_code).toBe(200)
    })
  })
})
