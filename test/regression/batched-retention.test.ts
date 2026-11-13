import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { runMaintenanceSweep, type SweepOptions } from '../../src/db/maintenance.js'
import { startTestDatabase, type TestDatabase } from '../helpers/test-db.js'
import { seedWorkload, type SeedWorkload } from '../helpers/seed.js'

/**
 * I8 regression: retention used to delete every expired event in ONE
 * statement (and one transaction with the other sweeps). After a long
 * downtime or the first run after enabling retention, that is a very large
 * delete holding locks and bloating tables. Events are now deleted in
 * bounded batches, each batch its own transaction; the expiry and
 * auto-disable sweeps run in their own transactions.
 */

const NEVER = 'http://localhost:9/never-served'

const sweepOptions = (overrides: Partial<SweepOptions> = {}): SweepOptions => ({
  retentionDays: 30,
  deliveryMaxAgeHours: 72,
  autoDisableAfterDays: 5,
  ...overrides,
})

async function backdate(pool: Pool, workload: SeedWorkload, days: number): Promise<void> {
  await pool.query(
    `UPDATE events SET created_at = now() - interval '${days} days'
     WHERE id IN (SELECT event_id FROM deliveries WHERE endpoint_id = $1)`,
    [workload.endpointId],
  )
}

describe('batched retention (I8)', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db.stop()
  })

  it('deletes more events than one batch holds, in several transactions, with the full cascade', async () => {
    const old = await seedWorkload(db.pool, { count: 5, endpointUrl: NEVER })
    const fresh = await seedWorkload(db.pool, { count: 2, endpointUrl: NEVER })
    await backdate(db.pool, old, 40)

    // Batch size 2: 5 old events take 3 transactions.
    const result = await runMaintenanceSweep(db.pool, sweepOptions({ retentionBatchSize: 2 }))
    expect(result.swept).toBe(true)
    expect(result.eventsDeleted).toBe(5)

    const oldLeft = await db.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM deliveries WHERE endpoint_id = $1`,
      [old.endpointId],
    )
    expect(Number(oldLeft.rows[0]!.n)).toBe(0)
    const oldAttempts = await db.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM delivery_attempts a
       JOIN deliveries d ON d.id = a.delivery_id
       WHERE d.endpoint_id = $1`,
      [old.endpointId],
    )
    expect(Number(oldAttempts.rows[0]!.n)).toBe(0)

    const freshLeft = await db.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM deliveries WHERE endpoint_id = $1 AND status = 'pending'`,
      [fresh.endpointId],
    )
    expect(Number(freshLeft.rows[0]!.n)).toBe(2)
  })

  it('a second sweep with nothing to prune is a no-op', async () => {
    const result = await runMaintenanceSweep(db.pool, sweepOptions({ retentionBatchSize: 2 }))
    expect(result.swept).toBe(true)
    expect(result.eventsDeleted).toBe(0)
  })
})
