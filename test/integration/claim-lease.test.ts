import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { claimDueDeliveries } from '../../src/dispatcher/claim.js'
import { startTestDatabase, type TestDatabase } from '../helpers/test-db.js'
import { seedWorkload, type SeedWorkload } from '../helpers/seed.js'

/**
 * Claiming and leases (DESIGN section 6.1), with absolute `now` injection:
 * waiting a minute in a test is a minute of wall-clock the suite does not
 * pay — claiming at a chosen instant exercises due/locked/expired without
 * sleeps.
 */

const URL = 'http://localhost:9/never'

const NOW = new Date('2026-01-15T12:00:00.000Z').getTime()
/** Seeded rows become due exactly at `NOW - 1 s`, before every claim instant used below. */
const SEED_DUE = new Date(NOW - 1_000)

const claim = (
  db: TestDatabase,
  overrides: Partial<Parameters<typeof claimDueDeliveries>[1]> = {},
) =>
  claimDueDeliveries(db.pool, {
    nowMs: NOW,
    batchSize: 100,
    perEndpointClaimCap: 10,
    leaseSeconds: 60,
    breakerCooldownSeconds: 60,
    ...overrides,
  })

async function countPending(db: TestDatabase, workload: SeedWorkload): Promise<number> {
  const result = await db.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM deliveries
     WHERE endpoint_id = $1 AND attempt_count = 0 AND locked_until IS NULL`,
    [workload.endpointId],
  )
  return Number(result.rows[0]!.n)
}

describe('claimDueDeliveries', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db.stop()
  })

  it('two concurrent claims take disjoint sets (FOR UPDATE SKIP LOCKED)', async () => {
    // Runs first: the file's other tests leave leftover rows behind, so
    // this test needs the still-empty database for its exact-union assert.
    const workload = await seedWorkload(db.pool, {
      count: 10,
      endpointUrl: URL,
      nextAttemptAt: SEED_DUE,
    })
    const [a, b] = await Promise.all([claim(db, { batchSize: 7 }), claim(db, { batchSize: 7 })])
    const idsA = a.map((c) => c.id)
    const idsB = b.map((c) => c.id)
    expect(new Set(idsA).size).toBe(idsA.length)
    expect(new Set(idsB).size).toBe(idsB.length)
    for (const id of idsA) expect(idsB).not.toContain(id)
    // Together they drain the whole backlog: no row claimed twice.
    expect(new Set([...idsA, ...idsB]).size).toBe(new Set(workload.deliveryIds).size)
  })

  it('claims a due delivery: attempt becomes the fencing token, lease is set', async () => {
    const workload = await seedWorkload(db.pool, {
      count: 1,
      endpointUrl: URL,
      nextAttemptAt: SEED_DUE,
    })
    const claimed = await claim(db)
    expect(claimed.map((c) => c.id)).toContain(workload.deliveryIds[0]!)
    const one = claimed.find((c) => c.id === workload.deliveryIds[0])!
    expect(one.attemptNumber).toBe(1)
    expect(one.eventId).toBeTruthy()
    expect(one.endpointId).toBe(workload.endpointId)
    const done = await claim(db)
    expect(done.map((c) => c.id)).not.toContain(workload.deliveryIds[0])
  })

  it('ignores a delivery whose next attempt is in the future, claims it once it is due', async () => {
    const workload = await seedWorkload(db.pool, {
      count: 1,
      endpointUrl: URL,
      nextAttemptAt: SEED_DUE,
    })
    await db.pool.query(`UPDATE deliveries SET next_attempt_at = $1 WHERE endpoint_id = $2`, [
      new Date(NOW + 5 * 60_000),
      workload.endpointId,
    ])
    expect((await claim(db)).map((c) => c.id)).not.toContain(workload.deliveryIds[0])
    // Six minutes later it is due — the same instant, no sleeps.
    const later = await claim(db, { nowMs: NOW + 6 * 60_000 })
    expect(later.map((c) => c.id)).toContain(workload.deliveryIds[0])
  })

  it('respects the lease: locked rows stay claimed until the lease expires', async () => {
    const workload = await seedWorkload(db.pool, {
      count: 1,
      endpointUrl: URL,
      nextAttemptAt: SEED_DUE,
    })
    expect(await countPending(db, workload)).toBe(1)
    const first = await claim(db, { leaseSeconds: 120 })
    expect(first).toHaveLength(1)
    expect(first[0]!.attemptNumber).toBe(1)

    // Certificate: locked (before `now + 120 s`) → nothing to claim.
    const beforeExpiry = await claim(db, { nowMs: NOW + 60_000 })
    expect(beforeExpiry.map((c) => c.id)).not.toContain(workload.deliveryIds[0])

    // But after the lease is up, the same row — newer attempt now.
    const afterExpiry = await claim(db, { nowMs: NOW + 121_000 })
    expect(afterExpiry.map((c) => c.id)).toContain(workload.deliveryIds[0])
    expect(
      await db.pool
        .query<{ attempt_count: number }>(`SELECT attempt_count FROM deliveries WHERE id = $1`, [
          workload.deliveryIds[0],
        ])
        .then((r) => r.rows[0]!.attempt_count),
    ).toBe(2)
  })

  it('skips disabled endpoints', async () => {
    const workload = await seedWorkload(db.pool, {
      count: 2,
      endpointUrl: URL,
      endpointStatus: 'disabled',
      nextAttemptAt: SEED_DUE,
    })
    expect((await claim(db)).map((c) => c.id)).toEqual(
      expect.not.arrayContaining(workload.deliveryIds),
    )
  })

  it('skips an open breaker within the cooldown, claims after it passes', async () => {
    const workload = await seedWorkload(db.pool, {
      count: 1,
      endpointUrl: URL,
      nextAttemptAt: SEED_DUE,
    })
    await db.pool.query(
      `UPDATE endpoints SET circuit_state = 'open', circuit_opened_at = $1,
              consecutive_failures = 4
       WHERE id = $2`,
      [new Date(NOW - 10_000), workload.endpointId],
    )
    // Opened 10 s ago; the 60 s cooldown has not passed.
    expect((await claim(db)).map((c) => c.id)).not.toContain(workload.deliveryIds[0])
    // Same instant as the cooldown end — claimable via `<=`.
    const afterCooldown = await claim(db, { nowMs: NOW + 50_000 })
    expect(afterCooldown.map((c) => c.id)).toContain(workload.deliveryIds[0])
  })
})

describe('per-endpoint capacity (exclusive database, exact counts)', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db.stop()
  })

  it('caps claims per endpoint and makes progress in follow-up batches', async () => {
    await seedWorkload(db.pool, { count: 25, endpointUrl: URL, nextAttemptAt: SEED_DUE })
    const first = await claim(db, { perEndpointClaimCap: 5, batchSize: 100 })
    expect(first).toHaveLength(5)
    // Cap binds below the batch: capacity, not the batch limit, is the ceiling.
    const second = await claim(db, { perEndpointClaimCap: 10, batchSize: 30 })
    // In-flight leases are subtracted from the cap: 10 − 5 leased = 5.
    expect(second).toHaveLength(5)
    // Once the leases have expired, the cap applies with nothing in flight.
    const third = await claim(db, { nowMs: NOW + 121_000, perEndpointClaimCap: 10, batchSize: 30 })
    expect(third).toHaveLength(10)
  })

  it('in-flight leases subtract from the cap; expired ones do not', async () => {
    await seedWorkload(db.pool, { count: 6, endpointUrl: URL, nextAttemptAt: SEED_DUE })
    const first = await claim(db, { perEndpointClaimCap: 5, batchSize: 2 })
    expect(first).toHaveLength(2)
    // In-flight leases subtract from the cap: with 2 leased, capacity is 3 —
    // not the 4 rows still claimable.
    const second = await claim(db, { perEndpointClaimCap: 5, batchSize: 10 })
    expect(second).toHaveLength(3)
    // After the leases expire they are not in flight anymore: all five
    // leased rows are claimable again (still nothing recorded them), and at
    // most the cap is taken.
    const third = await claim(db, { nowMs: NOW + 121_000, perEndpointClaimCap: 5, batchSize: 10 })
    expect(third).toHaveLength(5)
  })
})
