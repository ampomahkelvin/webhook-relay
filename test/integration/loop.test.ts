import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import {
  createDispatcher,
  type Dispatcher,
  type DispatcherConfig,
} from '../../src/dispatcher/loop.js'
import { startTestDatabase, type TestDatabase } from '../helpers/test-db.js'
import { seedWorkload, type SeedOptions, type SeedWorkload } from '../helpers/seed.js'
import { startReceiverServer, type ReceiverHandle } from '../helpers/receiver-server.js'
import { TEST_ENCRYPTION_KEY } from '../helpers/test-app.js'

/**
 * The dispatcher loop end to end against the sample receiver (DESIGN
 * sections 6.1–6.4): drain legally signed deliveries, honor Retry-After,
 * die after 8 attempts, re-claim immediately after a full batch, and stop
 * gracefully.
 */

async function waitUntil(
  predicate: () => Promise<boolean>,
  { timeoutMs = 30_000, stepMs = 25 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error('waitUntil: condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

const TINY_DELAYS = [10, 10, 10, 10, 10, 10, 10] as const

async function statusCounts(pool: Pool, endpointId: string): Promise<Record<string, number>> {
  const result = await pool.query<{ status: string; n: string }>(
    `SELECT status::text, count(*)::text AS n FROM deliveries
     WHERE endpoint_id = $1 GROUP BY status`,
    [endpointId],
  )
  return Object.fromEntries(result.rows.map((row) => [row.status, Number(row.n)]))
}

describe('dispatcher loop', () => {
  let db: TestDatabase
  let receiver: ReceiverHandle

  beforeAll(async () => {
    db = await startTestDatabase()
    receiver = await startReceiverServer()
  })
  afterAll(async () => {
    await receiver.close()
    await db.stop()
  })

  function makeDispatcher(seed: SeedWorkload, overrides: Partial<DispatcherConfig> = {}) {
    const config: DispatcherConfig = {
      concurrency: 8,
      batchSize: 4,
      perEndpointClaimCap: 4,
      pollIntervalMs: 30,
      leaseSeconds: 5,
      breakerThreshold: 5,
      breakerCooldownSeconds: 60,
      encryptionKeyBase64: TEST_ENCRYPTION_KEY,
      requestTimeoutMs: 2_000,
      allowInsecureHttp: true,
      allowPrivateTargets: true,
      delaysMs: TINY_DELAYS,
      ...overrides,
    }
    return createDispatcher(db.pool, config, {
      error: () => {},
      info: () => {},
      warn: () => {},
    } as never)
  }

  it('drains a small workload with valid signatures (delivered once each)', async () => {
    const seed = await seedWorkload(db.pool, {
      count: 12,
      endpointUrl: receiver.url,
      secret: receiver.secret,
    } satisfies SeedOptions)
    const dispatcher: Dispatcher = makeDispatcher(seed)
    dispatcher.start()
    try {
      await waitUntil(async () => (await statusCounts(db.pool, seed.endpointId)).succeeded === 12)
      expect(receiver.received.size).toBe(12)
      for (const webhook of receiver.received.values()) {
        expect(webhook.repeats).toBe(0)
      }
      const attempts = await db.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM delivery_attempts d JOIN deliveries ON deliveries.id = d.delivery_id
         WHERE deliveries.endpoint_id = $1`,
        [seed.endpointId],
      )
      expect(Number(attempts.rows[0]!.n)).toBe(12)
      expect(dispatcher.stats().stale).toBe(0)
    } finally {
      await dispatcher.stop()
    }
  })

  it('honors Retry-After by postponing but never shortening the schedule', async () => {
    const seed = await seedWorkload(db.pool, {
      count: 1,
      endpointUrl: `${receiver.url.replace('/hook', '')}/retry-after?failRate=1&status=503&retryAfterSeconds=900`,
      secret: receiver.secret,
    })
    const dispatcher = makeDispatcher(seed)
    dispatcher.start()
    try {
      await waitUntil(async () => {
        const counts = await statusCounts(db.pool, seed.endpointId)
        return counts.pending === 1 && dispatcher.stats().retried >= 1
      })
      const next = await db.pool.query<{ next_attempt_at: Date }>(
        `SELECT next_attempt_at FROM deliveries WHERE endpoint_id = $1`,
        [seed.endpointId],
      )
      const wait = next.rows[0]!.next_attempt_at.getTime() - Date.now()
      // 900 s floor: well beyond this test's lifetime; far above the 10 ms schedule.
      expect(wait).toBeGreaterThan(800_000)
      expect(wait).toBeLessThanOrEqual(900_000)
      expect((await statusCounts(db.pool, seed.endpointId)).pending).toBe(1)
    } finally {
      await dispatcher.stop()
    }
  })

  it('dies after the 8th failed attempt with the full attempt log', async () => {
    const seed = await seedWorkload(db.pool, {
      count: 1,
      endpointUrl: `${receiver.url.replace('/hook', '')}/flaky?failRate=1&status=500`,
      secret: receiver.secret,
    })
    const dispatcher = makeDispatcher(seed, { breakerThreshold: 999 })
    dispatcher.start()
    try {
      await waitUntil(async () => (await statusCounts(db.pool, seed.endpointId)).dead === 1, {
        timeoutMs: 20_000,
      })
      const attempt = await db.pool.query<{ attempt_count: number }>(
        `SELECT attempt_count FROM deliveries WHERE endpoint_id = $1`,
        [seed.endpointId],
      )
      expect(attempt.rows[0]!.attempt_count).toBe(8)
      const logged = await db.pool.query<{ a: number[] }>(
        `SELECT array_agg(attempt_number ORDER BY attempt_number) AS a
         FROM delivery_attempts da JOIN deliveries d ON d.id = da.delivery_id
         WHERE d.endpoint_id = $1`,
        [seed.endpointId],
      )
      expect(logged.rows[0]!.a).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      expect(dispatcher.stats().dead).toBe(1)
    } finally {
      await dispatcher.stop()
    }
  })

  it('a 410 kills the delivery immediately', async () => {
    const seed = await seedWorkload(db.pool, {
      count: 1,
      endpointUrl: `${receiver.url.replace('/hook', '')}/gone`,
      secret: receiver.secret,
    })
    const dispatcher = makeDispatcher(seed)
    dispatcher.start()
    try {
      await waitUntil(async () => (await statusCounts(db.pool, seed.endpointId)).dead === 1)
      const attempt = await db.pool.query<{ attempt_count: number }>(
        `SELECT attempt_count FROM deliveries WHERE endpoint_id = $1`,
        [seed.endpointId],
      )
      expect(attempt.rows[0]!.attempt_count).toBe(1)
    } finally {
      await dispatcher.stop()
    }
  })

  it('a full batch re-claims immediately instead of waiting the poll interval', async () => {
    const seed = await seedWorkload(db.pool, {
      count: 30,
      endpointUrl: receiver.url,
      secret: receiver.secret,
    })
    const dispatcher = makeDispatcher(seed, {
      batchSize: 5,
      perEndpointClaimCap: 10, // headroom: in-flight leases subtract from the cap
      pollIntervalMs: 2_000, // a sleep between batches would blow way past this
    })
    dispatcher.start()
    const startedAt = Date.now()
    try {
      await waitUntil(async () => (await statusCounts(db.pool, seed.endpointId)).succeeded === 30, {
        timeoutMs: 20_000,
      })
      const drainedInMs = Date.now() - startedAt
      // 6 batches × 5: with an eager re-claim this is send-bound (< 1 s on
      // loopback); a sleep per batch alone would cost > 10 s.
      expect(drainedInMs).toBeLessThan(5_500)
    } finally {
      await dispatcher.stop()
    }
  })

  it('stops gracefully: in-flight sends finish, then no more claims happen', async () => {
    const seed = await seedWorkload(db.pool, {
      count: 40,
      endpointUrl: receiver.url,
      secret: receiver.secret,
    })
    const dispatcher = makeDispatcher(seed, {
      concurrency: 3,
      batchSize: 2,
      perEndpointClaimCap: 8,
    })
    dispatcher.start()
    await waitUntil(async () => dispatcher.stats().succeeded >= 5)
    const stopStartedAt = Date.now()
    await dispatcher.stop()
    const stopTookMs = Date.now() - stopStartedAt
    expect(stopTookMs).toBeLessThan(5_000)
    expect(dispatcher.inFlightCount()).toBe(0)
    // Everything claimed was also sent and recorded; nothing was dropped.
    expect(dispatcher.stats().sends).toBe(dispatcher.stats().claims)
    expect(dispatcher.stats().stale).toBe(0)
    const done = await statusCounts(db.pool, seed.endpointId)
    expect(done.succeeded).toBeGreaterThanOrEqual(5)
    expect((done.pending ?? 0) + (done.succeeded ?? 0)).toBe(40)
    // No further progress counts after stop: the counters are frozen.
    const frozen = dispatcher.stats()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(dispatcher.stats()).toEqual(frozen)
  })
})
