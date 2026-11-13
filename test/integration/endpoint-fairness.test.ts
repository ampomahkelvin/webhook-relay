import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDispatcher, type DispatcherConfig } from '../../src/dispatcher/loop.js'
import { startTestDatabase, type TestDatabase } from '../helpers/test-db.js'
import { seedWorkload } from '../helpers/seed.js'
import { startReceiverServer, type ReceiverHandle } from '../helpers/receiver-server.js'
import { startModeServer, type ModeServer } from '../helpers/mode-server.js'
import { TEST_ENCRYPTION_KEY } from '../helpers/test-app.js'
import { createLogger } from '../../src/logger.js'

/**
 * Per-endpoint claim-cap fairness (DESIGN section 6.1): a hung receiver
 * may hog its capped share of the claim batch, but it must not delay
 * another endpoint's deliveries behind the whole of its backlog.
 */
describe("a hung endpoint does not delay another endpoint's deliveries", () => {
  let db: TestDatabase
  let hung: ModeServer
  let healthyReceiver: ReceiverHandle
  beforeAll(async () => {
    db = await startTestDatabase()
    hung = await startModeServer()
    healthyReceiver = await startReceiverServer()
  })
  afterAll(async () => {
    await hung.close()
    await healthyReceiver.close()
    await db.stop()
  })

  const dispatcherConfig: DispatcherConfig = {
    concurrency: 8,
    batchSize: 10,
    perEndpointClaimCap: 5,
    pollIntervalMs: 20,
    leaseSeconds: 5,
    breakerThreshold: 999, // fairness must come from the cap, not the breaker
    breakerCooldownSeconds: 60,
    encryptionKeyBase64: TEST_ENCRYPTION_KEY,
    requestTimeoutMs: 1_000, // tarpitted sends occupy a slot at most this long
    allowInsecureHttp: true,
    allowPrivateTargets: true,
  }

  it('the healthy endpoint drains fully while the tarpit hogs its share', async () => {
    hung.mode.behavior = 'tarpit'
    hung.mode.tarpitMs = 4_000
    const backlog = await seedWorkload(db.pool, {
      count: 60,
      endpointUrl: hung.url,
      nextAttemptAt: new Date(),
    })
    const quick = await seedWorkload(db.pool, {
      count: 10,
      endpointUrl: healthyReceiver.url,
      secret: healthyReceiver.secret,
      nextAttemptAt: new Date(),
    })

    const dispatcher = createDispatcher(db.pool, dispatcherConfig, createLogger('test', 'fatal'))
    dispatcher.start()
    try {
      // The per-batch cap shares slots 5/5 across the two endpoints; even
      // with 60 queued deliveries stuck behind 4 s tarpits, the healthy
      // endpoint's 10 deliveries must finish inside a couple of seconds.
      const deadline = Date.now() + 10_000
      for (;;) {
        const quickDone = Number(
          (
            await db.pool.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM deliveries WHERE endpoint_id = $1 AND status = 'succeeded'`,
              [quick.endpointId],
            )
          ).rows[0]!.n,
        )
        if (quickDone === 10) break
        if (Date.now() > deadline) throw new Error(`healthy endpoint stalled at ${quickDone}/10`)
        await new Promise((r) => setTimeout(r, 50))
      }

      // Fairness, not takeover: far less than the whole backlog has even
      // been attempted.
      const attempted = Number(
        (
          await db.pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM deliveries WHERE endpoint_id = $1 AND attempt_count > 0`,
            [backlog.endpointId],
          )
        ).rows[0]!.n,
      )
      expect(attempted).toBeLessThan(30)
    } finally {
      await dispatcher.stop()
    }
  })
})
