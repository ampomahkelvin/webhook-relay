import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { claimDueDeliveries } from '../../src/dispatcher/claim.js'
import { startTestDatabase, type TestDatabase } from '../helpers/test-db.js'
import { seedWorkload, type SeedWorkload } from '../helpers/seed.js'

/**
 * I3 regression: the claim's `picked` CTE ordered candidates by `id` — a
 * random UUID — so when more was claimable than the batch size, the choice
 * among endpoints was random and a long-overdue delivery could wait behind
 * newer ones. Claims must be oldest-due first across endpoints too.
 */

const NOW = new Date('2026-04-01T10:00:00.000Z').getTime()

describe('claims pick the oldest due delivery first (I3)', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db.stop()
  })

  it('one very overdue endpoint is claimed before a fresher one at batch size 1', async () => {
    const fresh: SeedWorkload = await seedWorkload(db.pool, {
      count: 3,
      endpointUrl: 'http://localhost:9/fresh',
      nextAttemptAt: new Date(NOW - 1_000),
    })
    const overdue: SeedWorkload = await seedWorkload(db.pool, {
      count: 3,
      endpointUrl: 'http://localhost:9/overdue',
      nextAttemptAt: new Date(NOW - 30 * 60_000),
    })

    const claimed = await claimDueDeliveries(db.pool, {
      nowMs: NOW,
      batchSize: 1,
      perEndpointClaimCap: 10,
      leaseSeconds: 60,
      breakerCooldownSeconds: 60,
    })
    expect(claimed).toHaveLength(1)
    expect(claimed[0]!.id).toBe(overdue.deliveryIds[0])
    expect(claimed[0]!.endpointId).toBe(overdue.endpointId)
    expect(claimed.map((c) => c.id)).not.toContain(fresh.deliveryIds[0])
  })

  it('within a batch, due-time order is preserved across endpoints', async () => {
    const a = await seedWorkload(db.pool, {
      count: 1,
      endpointUrl: 'http://localhost:9/a',
      nextAttemptAt: new Date(NOW - 5_000),
    })
    const b = await seedWorkload(db.pool, {
      count: 1,
      endpointUrl: 'http://localhost:9/b',
      nextAttemptAt: new Date(NOW - 2_000),
    })
    const claimed = await claimDueDeliveries(db.pool, {
      nowMs: NOW,
      batchSize: 10,
      perEndpointClaimCap: 10,
      leaseSeconds: 60,
      breakerCooldownSeconds: 60,
    })
    const order = claimed.map((c) => c.id)
    expect(order.indexOf(a.deliveryIds[0]!)).toBeLessThan(order.indexOf(b.deliveryIds[0]!))
  })
})
