import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createDispatcher } from '../../src/dispatcher/loop.js'
import { startTestDatabase, type TestDatabase } from '../helpers/test-db.js'
import { seedWorkload, type SeedWorkload } from '../helpers/seed.js'
import { startReceiverServer, type ReceiverHandle } from '../helpers/receiver-server.js'
import { TEST_ENCRYPTION_KEY } from '../helpers/test-app.js'
import { createLogger } from '../../src/logger.js'

/**
 * C1 regression, second half: a recording failure after a SUCCESSFUL send
 * must not re-send the delivery. The old code treated the thrown record as
 * a worker error and re-recorded it as a retry `pollIntervalMs` later —
 * re-sending every 500 ms to a receiver that had already answered.
 *
 * The fix: the record is idempotent (fenced by attempt_count), so the
 * dispatcher retries the RECORD; the send happens once.
 */

const SILENT = createLogger('test', 'fatal')

/**
 * A pool wrapper that fails exactly one `connect()` — the record's first
 * attempt. Connection budget: claim (1), details fetch (2), record (3 =
 * FAILS), record retry (4 = real pool again).
 */
function poolThatDropsOneConnect(pool: Pool): Pool {
  let calls = 0
  const wrapped = {
    connect: async () => {
      calls++
      if (calls === 3) throw new Error('injected record failure')
      return pool.connect()
    },
    query: pool.query.bind(pool),
    end: pool.end.bind(pool),
  }
  return wrapped as unknown as Pool
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  { timeoutMs = 20_000, stepMs = 25 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error('waitUntil: condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

describe('a record failure after a successful send does not re-send (C1)', () => {
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

  it('retries the record, delivers exactly once, and reports the success', async () => {
    const workload: SeedWorkload = await seedWorkload(db.pool, {
      count: 1,
      endpointUrl: receiver.url,
      secret: receiver.secret,
    })
    const dispatcher = createDispatcher(
      poolThatDropsOneConnect(db.pool),
      {
        concurrency: 2,
        batchSize: 2,
        perEndpointClaimCap: 2,
        pollIntervalMs: 50, // the old bug re-sent every interval; prove it does not
        leaseSeconds: 60,
        breakerThreshold: 5,
        breakerCooldownSeconds: 60,
        encryptionKeyBase64: TEST_ENCRYPTION_KEY,
        requestTimeoutMs: 3_000,
        allowInsecureHttp: true,
        allowPrivateTargets: true,
      },
      SILENT,
    )
    dispatcher.start()
    try {
      await waitUntil(async () => {
        const row = await db.pool
          .query<{ status: string }>(`SELECT status::text FROM deliveries WHERE id = $1`, [
            workload.deliveryIds[0],
          ])
          .then((r) => r.rows[0]?.status)
        return row === 'succeeded'
      })
      // Settled. Wait past several poll intervals: any wrongful re-send
      // would show up as a repeat on the receiver.
      await new Promise((resolve) => setTimeout(resolve, 400))

      const webhooks = [...receiver.received.values()]
      expect(webhooks).toHaveLength(1)
      expect(webhooks[0]!.repeats).toBe(0)

      const delivery = await db.pool
        .query<{ attempt_count: number; locked_until: Date | null }>(
          `SELECT attempt_count, locked_until FROM deliveries WHERE id = $1`,
          [workload.deliveryIds[0]],
        )
        .then((r) => r.rows[0]!)
      expect(delivery.attempt_count).toBe(1)

      // The record retry SUCCEEDED, so the outcome is reported as a
      // success — not smuggled through the worker-error path as a retry.
      expect(dispatcher.stats().sends).toBe(1)
      expect(dispatcher.stats().succeeded).toBe(1)
      expect(dispatcher.stats().retried).toBe(0)
      expect(dispatcher.stats().stale).toBe(0)
    } finally {
      await dispatcher.stop()
    }
  })
})
