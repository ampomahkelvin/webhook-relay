import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDispatcher } from '../../src/dispatcher/loop.js'
import { startTestDatabase, type TestDatabase } from '../helpers/test-db.js'
import { seedWorkload } from '../helpers/seed.js'
import { startReceiverServer, type ReceiverHandle } from '../helpers/receiver-server.js'
import { endpointState } from '../helpers/endpoint-state.js'
import { TEST_ENCRYPTION_KEY } from '../helpers/test-app.js'
import { createLogger } from '../../src/logger.js'

/**
 * The 410 path end to end (DESIGN section 7): a single `gone` answer
 * kills the delivery dead AND disables its endpoint, before any other
 * delivery of that endpoint reaches the network.
 */
describe('a 410 kills the delivery and disables the endpoint', () => {
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

  it('records the delivery dead and disables the endpoint with reason gone', async () => {
    const seed = await seedWorkload(db.pool, {
      count: 2,
      endpointUrl: `${receiver.url.replace('/hook', '')}/gone`,
      secret: receiver.secret,
      nextAttemptAt: new Date(),
    })
    // batchSize 1 keeps the two deliveries ordered: the first 410 disables
    // the endpoint BEFORE the second gets anywhere near the network.
    const dispatcher = createDispatcher(
      db.pool,
      {
        concurrency: 2,
        batchSize: 1,
        perEndpointClaimCap: 1,
        pollIntervalMs: 30,
        leaseSeconds: 10,
        breakerThreshold: 999,
        breakerCooldownSeconds: 60,
        encryptionKeyBase64: TEST_ENCRYPTION_KEY,
        requestTimeoutMs: 2_000,
        allowInsecureHttp: true,
        allowPrivateTargets: true,
      },
      createLogger('test', 'silent'),
    )
    dispatcher.start()
    try {
      for (let i = 0; i < 100 && dispatcher.stats().dead < 1; i++) {
        await new Promise((r) => setTimeout(r, 50))
      }
      const dead = Number(
        (
          await db.pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM deliveries WHERE endpoint_id = $1 AND status = 'dead'`,
            [seed.endpointId],
          )
        ).rows[0]!.n,
      )
      expect(dead).toBe(1)
      const state = await endpointState(db.pool, seed.endpointId)
      expect(state.status).toBe('disabled')
      expect(state.disabled_reason).toBe('gone')
    } finally {
      await dispatcher.stop()
    }
  })
})
