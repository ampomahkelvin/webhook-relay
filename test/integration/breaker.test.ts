import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { claimDueDeliveries } from '../../src/db/delivery-queue.js'
import { recordAttempt } from '../../src/db/delivery-queue.js'
import { startTestDatabase, type TestDatabase } from '../helpers/test-db.js'
import { endpointState } from '../helpers/endpoint-state.js'
import { seedWorkload } from '../helpers/seed.js'

/**
 * The breaker applied to recorded results (DESIGN section 7). Every test
 * starts from an empty database (TRUNCATE between tests): the claim batch
 * is GLOBAL, so leftover due rows from sibling tests would end up in
 * exact-count assertions. Real clocks stay unused — cooldown probes are
 * driven by claiming at injected instants.
 */

// Real-clock base with offsets: the breaker clock in record uses Date.now(),
// so cooldown boundaries must be computed against this same clock.
const T0 = Date.now()

interface FailArgs {
  deliveryId: string
  endpointId: string
  claimedAttempt: number
  threshold?: number
}

/** recordAttempt wired for the pure-failure path (HTTP 500, scheduled retry). */
const failed = (db: TestDatabase, args: FailArgs) =>
  recordAttempt(db.pool, {
    deliveryId: args.deliveryId,
    endpointId: args.endpointId,
    claimedAttempt: args.claimedAttempt,
    breakerThreshold: args.threshold ?? 3,
    outcome: { kind: 'retry', nextAttemptAtMs: T0 + args.claimedAttempt * 2_000 }, // due 2 s later; claims stagger to match
    startedAtMs: T0,
    durationMs: 25,
    statusCode: 500,
    responseSnippet: 'kaboom',
  })

export const succeededAttempt = (db: TestDatabase, args: FailArgs) =>
  recordAttempt(db.pool, {
    deliveryId: args.deliveryId,
    endpointId: args.endpointId,
    claimedAttempt: args.claimedAttempt,
    breakerThreshold: args.threshold ?? 3,
    outcome: { kind: 'succeeded' },
    startedAtMs: T0,
    durationMs: 25,
    statusCode: 200,
  })

const claim = (
  db: TestDatabase,
  overrides: Partial<Parameters<typeof claimDueDeliveries>[1]> = {},
) =>
  claimDueDeliveries(db.pool, {
    nowMs: T0,
    batchSize: 20,
    perEndpointClaimCap: 10,
    leaseSeconds: 60,
    breakerCooldownSeconds: 60,
    ...overrides,
  })

describe('the breaker applied from recorded results', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  beforeEach(async () => {
    // One global claim batch per test; leftovers would pollute exact counts.
    await db.pool.query(
      `TRUNCATE delivery_attempts, deliveries, events, endpoints, api_keys, tenants CASCADE`, // release 1
    )
  })
  afterAll(async () => {
    await db.stop()
  })

  it('opens after N consecutive failures, stays closed below, blocks through the cooldown', async () => {
    const seed = await seedWorkload(db.pool, {
      count: 3,
      endpointUrl: 'http://localhost:9/never',
      nextAttemptAt: new Date(T0),
    })

    // Below the threshold: still closed, counter rising.
    let cl = (await claim(db, { batchSize: 1 }))[0]!
    await failed(db, {
      deliveryId: cl.id,
      endpointId: seed.endpointId,
      claimedAttempt: cl.attemptNumber,
    })
    let state = await endpointState(db.pool, seed.endpointId)
    expect(state.circuit_state).toBe('closed')
    expect(state.consecutive_failures).toBe(1)
    expect(state.failing_since).not.toBeNull()
    expect(state.circuit_opened_at).toBeNull()

    cl = (await claim(db, { nowMs: T0 + 2_000, batchSize: 1 }))[0]!
    await failed(db, {
      deliveryId: cl.id,
      endpointId: seed.endpointId,
      claimedAttempt: cl.attemptNumber,
    })
    state = await endpointState(db.pool, seed.endpointId)
    expect(state.circuit_state).toBe('closed')

    // Third consecutive failure opens the breaker.
    cl = (await claim(db, { nowMs: T0 + 4_000, batchSize: 1 }))[0]!
    await failed(db, {
      deliveryId: cl.id,
      endpointId: seed.endpointId,
      claimedAttempt: cl.attemptNumber,
    })
    state = await endpointState(db.pool, seed.endpointId)
    expect(state.circuit_state).toBe('open')
    expect(state.consecutive_failures).toBe(3)
    expect(Math.abs(state.circuit_opened_at!.getTime() - (T0 + 4_000))).toBeLessThan(5_000)

    // Open: nothing claimable even though everything is due.
    expect(await claim(db, { nowMs: T0 + 30_000 })).toHaveLength(0)
  })

  it('exactly one probe after the cooldown puts the endpoint half-open', async () => {
    const seed = await seedWorkload(db.pool, {
      count: 4,
      endpointUrl: 'http://localhost:9/never',
      nextAttemptAt: new Date(T0),
    })
    for (const attempt of [1, 2, 3]) {
      const [cl] = await claim(db, { nowMs: T0 + (attempt - 1) * 2_000, batchSize: 1 })
      await failed(db, {
        deliveryId: cl!.id,
        endpointId: seed.endpointId,
        claimedAttempt: cl!.attemptNumber,
      })
    }
    // Cooldown has passed (opened at T0+4s, cooldown 60s): exactly ONE row is
    // claimed and flagged as the probe; the endpoint is moved to half_open
    // in the same transaction.
    const probe = await claim(db, { nowMs: T0 + 65_000, batchSize: 20 })
    expect(probe).toHaveLength(1)
    expect(probe[0]!.probe).toBe(true)
    const state = await endpointState(db.pool, seed.endpointId)
    expect(state.circuit_state).toBe('half_open')
    expect(state.circuit_opened_at!.getTime()).toBe(T0 + 65_000)

    // While the probe is in flight its cooldown forbids a second probe.
    expect(await claim(db, { nowMs: T0 + 70_000 })).toHaveLength(0)
  })

  it('a probe success closes the breaker and clears the counters', async () => {
    const seed = await seedWorkload(db.pool, {
      count: 3,
      endpointUrl: 'http://localhost:9/never',
      nextAttemptAt: new Date(T0),
    })
    for (const attempt of [1, 2, 3]) {
      const [cl] = await claim(db, { nowMs: T0 + (attempt - 1) * 2_000, batchSize: 1 })
      await failed(db, {
        deliveryId: cl!.id,
        endpointId: seed.endpointId,
        claimedAttempt: cl!.attemptNumber,
      })
    }
    const probe = await claim(db, { nowMs: T0 + 65_000 })
    await succeededAttempt(db, {
      deliveryId: probe[0]!.id,
      endpointId: seed.endpointId,
      claimedAttempt: probe[0]!.attemptNumber,
    })
    const state = await endpointState(db.pool, seed.endpointId)
    expect(state.circuit_state).toBe('closed')
    expect(state.consecutive_failures).toBe(0)
    expect(state.failing_since).toBeNull()
    expect(state.circuit_opened_at).toBeNull()

    // Normal claiming resumes: the other two deliveries come through.
    const rest = await claim(db, { nowMs: T0 + 66_000, batchSize: 20 })
    expect(rest).toHaveLength(2)
    expect(rest.every((c) => !c.probe)).toBe(true)
  })

  it('a probe failure reopens with a fresh cooldown, then re-probes', async () => {
    const seed = await seedWorkload(db.pool, {
      count: 4,
      endpointUrl: 'http://localhost:9/never',
      nextAttemptAt: new Date(T0),
    })
    for (const attempt of [1, 2, 3]) {
      const [cl] = await claim(db, { nowMs: T0 + (attempt - 1) * 2_000, batchSize: 1 })
      await failed(db, {
        deliveryId: cl!.id,
        endpointId: seed.endpointId,
        claimedAttempt: cl!.attemptNumber,
      })
    }
    let probe = (await claim(db, { nowMs: T0 + 65_000 }))[0]!
    await failed(db, {
      deliveryId: probe.id,
      endpointId: seed.endpointId,
      claimedAttempt: probe.attemptNumber,
    })
    const reopened = await endpointState(db.pool, seed.endpointId)
    expect(reopened.circuit_state).toBe('open')
    expect(reopened.consecutive_failures).toBe(4)
    // A failing probe reopens with a FRESH cooldown: opened_at is later than
    // any opening instant this test could have produced before the probe.
    expect(reopened.circuit_opened_at!.getTime()).toBeGreaterThan(T0)

    // New cooldown (opened_at reset) blocks until it passes again. The
    // record clock is real now (≈T0), so the block covers the first ~60 s.
    expect(await claim(db, { nowMs: T0 + 30_000 })).toHaveLength(0)
    probe = (await claim(db, { nowMs: T0 + 75_000 }))[0]!
    expect(probe!.probe).toBe(true)
    const probingAgain = await endpointState(db.pool, seed.endpointId)
    expect(probingAgain.circuit_state).toBe('half_open')
    expect(probingAgain.circuit_opened_at!.getTime()).toBe(T0 + 75_000)
  })
})

describe('healthy endpoints cause no endpoint-row writes', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
    // Count every endpoints UPDATE in this database.
    await db.pool.query(
      `CREATE TABLE endpoint_writes AS SELECT * FROM endpoints WHERE false;
       CREATE FUNCTION note_endpoint_write() RETURNS trigger AS $$
         BEGIN INSERT INTO endpoint_writes (id) VALUES (NEW.id); RETURN NULL; END;
       $$ LANGUAGE plpgsql;
       CREATE TRIGGER endpoints_write_note AFTER UPDATE ON endpoints
         FOR EACH ROW EXECUTE FUNCTION note_endpoint_write();`,
    )
  })
  beforeEach(async () => {
    await db.pool.query(
      `TRUNCATE endpoint_writes; TRUNCATE delivery_attempts, deliveries, events, endpoints, api_keys, tenants CASCADE`,
    )
  })
  afterAll(async () => {
    await db.pool.query(
      `DROP TRIGGER endpoints_write_note ON endpoints; DROP FUNCTION note_endpoint_write();
       DROP TABLE endpoint_writes;`,
    )
    await db.stop()
  })

  it('draining a healthy endpoint updates not a single row; a failure does', async () => {
    const seed = await seedWorkload(db.pool, {
      count: 6,
      endpointUrl: 'http://localhost:9/never',
      nextAttemptAt: new Date(T0),
    })
    for (let i = 0; i < 6; i++) {
      const [cl] = await claim(db, { batchSize: 1 })
      await succeededAttempt(db, {
        deliveryId: cl!.id,
        endpointId: seed.endpointId,
        claimedAttempt: cl!.attemptNumber,
      })
    }
    const writes = async () =>
      Number(
        (await db.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM endpoint_writes`))
          .rows[0]!.n,
      )
    expect(await writes()).toBe(0)

    // One failure is one write (the failing_since clock starts).
    const failureSeed = await seedWorkload(db.pool, {
      count: 1,
      endpointUrl: 'http://localhost:9/never',
      nextAttemptAt: new Date(T0),
    })
    const [cl] = await claim(db, { batchSize: 1 })
    await failed(db, {
      deliveryId: cl!.id,
      endpointId: failureSeed.endpointId,
      claimedAttempt: cl!.attemptNumber,
    })
    expect(await writes()).toBe(1)
  })
})
