import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import {
  createDispatcher,
  type Dispatcher,
  type DispatcherConfig,
} from '../../src/dispatcher/loop.js'
import { createLogger } from '../../src/logger.js'
import { startModeServer, type ModeServer } from '../helpers/mode-server.js'
import { startOpsContext, TINY_DELAYS, waitUntil, type OpsContext } from '../helpers/ops-context.js'
import { TEST_ENCRYPTION_KEY } from '../helpers/test-app.js'

/**
 * Replay (PLAN phase 7 / DESIGN section 10): the route-level guards on a
 * settled delivery, and the end-to-end replay through the real dispatcher
 * (dead once the receiver fails, succeeding once it recovers, attempt
 * numbers unique across the replay).
 */
describe('replay of settled deliveries', () => {
  let ctx: OpsContext
  const alice = () => ctx.alice
  const env = () => ctx.env
  // Thin wrappers so the helpers read naturally while still binding after
  // beforeAll has run.
  const pool = () => ctx.pool()
  const bearerFor = (t: OpsContext['alice']) => ctx.bearerFor(t)
  const createEndpoint = (t: OpsContext['alice'], url: string) => ctx.createEndpoint(t, url)
  const submitEvent = (t: OpsContext['alice'], eventType?: string) => ctx.submitEvent(t, eventType)
  const deliveryOf = (t: OpsContext['alice'], eventId: string, endpointId: string) =>
    ctx.deliveryOf(t, eventId, endpointId)

  beforeAll(async () => {
    ctx = await startOpsContext()
  })
  afterAll(async () => {
    await env().stop()
  })

  describe('POST /v1/deliveries/:id/replay — single-delivery checks', () => {
    it('409s a pending delivery and 404s unknown ids', async () => {
      const endpointId = await createEndpoint(alice(), 'http://localhost:9/never-served')
      const eventId = await submitEvent(alice())
      const pending = await deliveryOf(alice(), eventId, endpointId)

      const conflict = await request(env().app)
        .post(`/v1/deliveries/${pending.id}/replay`)
        .set(bearerFor(alice()))
      expect(conflict.status).toBe(409)
      expect(conflict.body.code).toBe('NOT_REPLAYABLE')

      const unknown = await request(env().app)
        .post('/v1/deliveries/00000000-0000-4000-8000-000000000000/replay')
        .set(bearerFor(alice()))
      expect(unknown.status).toBe(404)
    })

    it('409s DELIVERY_IN_FLIGHT for a leased dead delivery', async () => {
      const endpointId = await createEndpoint(alice(), 'http://localhost:9/never-served')
      const eventId = await submitEvent(alice())
      const delivery = await deliveryOf(alice(), eventId, endpointId)
      // A worker holding the lease on a settled-or-not row blocks replay.
      await pool().query(
        `UPDATE deliveries SET status = 'dead', completed_at = now(),
                locked_until = now() + interval '1 hour', attempt_count = 3, cycle_start = 2
         WHERE id = $1`,
        [delivery.id],
      )
      const leased = await request(env().app)
        .post(`/v1/deliveries/${delivery.id}/replay`)
        .set(bearerFor(alice()))
      expect(leased.status).toBe(409)
      expect(leased.body.code).toBe('DELIVERY_IN_FLIGHT')
    })

    it('replays a dead delivery: pending now, schedule restarts without renumbering', async () => {
      const endpointId = await createEndpoint(alice(), 'http://localhost:9/never-served')
      const eventId = await submitEvent(alice())
      const delivery = await deliveryOf(alice(), eventId, endpointId)
      await pool().query(
        `UPDATE deliveries SET status = 'dead', completed_at = now(),
                attempt_count = 4, cycle_start = 0
         WHERE id = $1`,
        [delivery.id],
      )

      const replayed = await request(env().app)
        .post(`/v1/deliveries/${delivery.id}/replay`)
        .set(bearerFor(alice()))
      expect(replayed.status).toBe(202)
      expect(replayed.body.delivery).toMatchObject({
        id: delivery.id,
        status: 'pending',
        attemptCount: 4,
        cycleStart: 4, // schedule index restarts at attempt_count
        completedAt: null,
      })
      expect(replayed.body.delivery.nextAttemptAt).toBeDefined()
    })
  })

  describe('replay end-to-end with the dispatcher', () => {
    let mode: ModeServer
    let dispatcher: Dispatcher

    const config: DispatcherConfig = {
      concurrency: 4,
      batchSize: 5,
      perEndpointClaimCap: 5,
      pollIntervalMs: 20,
      leaseSeconds: 10,
      breakerThreshold: 999, // this suite exercises retries, not the breaker
      breakerCooldownSeconds: 60,
      encryptionKeyBase64: TEST_ENCRYPTION_KEY,
      requestTimeoutMs: 2_000,
      allowInsecureHttp: true,
      allowPrivateTargets: true,
      delaysMs: TINY_DELAYS,
    }

    const statusOf = async (deliveryId: string): Promise<string | undefined> => {
      const row = await pool().query<{ status: string }>(
        'SELECT status::text FROM deliveries WHERE id = $1',
        [deliveryId],
      )
      return row.rows[0]?.status
    }

    beforeAll(async () => {
      mode = await startModeServer()
    })
    beforeEach(async () => {
      mode.mode.behavior = 'ok'
    })
    afterEach(async () => {
      if (dispatcher) await dispatcher.stop()
    })
    afterAll(async () => {
      await mode.close()
    })

    it('a dead delivery succeeds once the receiver recovers; numbers stay unique', async () => {
      const endpointId = await createEndpoint(alice(), mode.url)
      const eventId = await submitEvent(alice())
      const delivery = await deliveryOf(alice(), eventId, endpointId)

      // The receiver fails everything: 8 attempts, then dead.
      mode.mode.behavior = 'fail'
      dispatcher = createDispatcher(pool(), config, createLogger('test', 'silent'))
      dispatcher.start()
      await waitUntil(async () => (await statusOf(delivery.id)) === 'dead')
      await dispatcher.stop()

      const deadRow = await pool().query<{ attempt_count: number }>(
        'SELECT attempt_count FROM deliveries WHERE id = $1',
        [delivery.id],
      )
      expect(deadRow.rows[0]!.attempt_count).toBe(8)

      // The receiver recovers; replay queues the delivery again.
      mode.mode.behavior = 'ok'
      const replayed = await request(env().app)
        .post(`/v1/deliveries/${delivery.id}/replay`)
        .set(bearerFor(alice()))
      expect(replayed.status).toBe(202)
      expect(replayed.body.delivery.cycleStart).toBe(8)

      dispatcher = createDispatcher(pool(), config, createLogger('test', 'silent'))
      dispatcher.start()
      await waitUntil(async () => (await statusOf(delivery.id)) === 'succeeded')
      await dispatcher.stop()

      // Attempt numbers stayed unique: the 8 failed attempts keep their
      // numbers, the replay's schedule restarted at cycle_start 8 and its
      // attempts numbered on from there (9 > 8, all distinct).
      const numbered = await pool().query<{ numbers: number[] }>(
        `SELECT array_agg(attempt_number ORDER BY attempt_number) AS numbers
         FROM delivery_attempts WHERE delivery_id = $1`,
        [delivery.id],
      )
      const numbers = numbered.rows[0]!.numbers
      expect(numbers.filter((n) => n <= 8)).toHaveLength(8)
      expect(new Set(numbers).size).toBe(numbers.length)

      const final = await request(env().app)
        .get(`/v1/deliveries/${delivery.id}`)
        .set(bearerFor(alice()))
      expect(final.body.delivery.attemptCount).toBe(numbers.length)
      expect(final.body.delivery.completedAt).not.toBeNull()
    })
  })
})
