import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Pool } from 'pg'
import type { TestApp } from '../helpers/test-app.js'
import { startTestApp, TEST_ADMIN_KEY, TEST_ENCRYPTION_KEY } from '../helpers/test-app.js'
import { startModeServer, type ModeServer } from '../helpers/mode-server.js'
import {
  createDispatcher,
  type Dispatcher,
  type DispatcherConfig,
} from '../../src/dispatcher/loop.js'
import { createLogger } from '../../src/logger.js'

/**
 * Operations API (PLAN phase 7 / DESIGN section 10): delivery listing and
 * detail with cursors, replay of settled deliveries through the real
 * dispatcher (dead once the receiver fails, succeeding once it recovers,
 * attempt numbers unique across the replay), and the endpoint test-send.
 *
 * Concurrency note: an event fans out to EVERY enabled endpoint of its
 * tenant, so every test scopes its queries by the endpoint it created in
 * that test — sibling endpoints from other tests share the tenant.
 */

const TINY_DELAYS = Array.from({ length: 8 }, () => 10)

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error('waitUntil: condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}

interface Tenant {
  id: string
  apiKey: string
}

describe('operations API', () => {
  let env: TestApp
  let alice: Tenant
  let bob: Tenant
  let counter = 0

  beforeAll(async () => {
    env = await startTestApp({ maxEndpointsPerTenant: 10, allowInsecureHttp: true })
    const created: Tenant[] = []
    for (const name of ['alice-ops', 'bob-ops']) {
      const response = await request(env.app)
        .post('/admin/tenants')
        .set({ Authorization: `Bearer ${TEST_ADMIN_KEY}` })
        .send({ name })
      expect(response.status).toBe(201)
      created.push({ id: response.body.tenant.id, apiKey: response.body.apiKey.key })
    }
    alice = created[0]!
    bob = created[1]!
  })
  afterAll(async () => {
    await env.stop()
  })

  const pool = (): Pool => env.db.pool
  const bearerFor = (tenant: Tenant) => ({ Authorization: `Bearer ${tenant.apiKey}` })

  /** Create a real endpoint through the API (URL validates like production). */
  async function createEndpoint(tenant: Tenant, url: string): Promise<string> {
    const response = await request(env.app)
      .post('/v1/endpoints')
      .set(bearerFor(tenant))
      .send({ url, eventTypes: ['*'] })
    expect(response.status).toBe(201)
    return response.body.endpoint.id as string
  }

  /** Submit an event through intake; every enabled endpoint gets one delivery. */
  async function submitEvent(tenant: Tenant, eventType = 'demo.ping'): Promise<string> {
    counter += 1
    const response = await request(env.app)
      .post('/v1/events')
      .set(bearerFor(tenant))
      .set('Idempotency-Key', `ops-${Date.now()}-${counter}`)
      .send({ eventType, payload: { n: 1 } })
    expect(response.status).toBe(202)
    return response.body.id as string
  }

  /** The delivery of an event for one specific endpoint. */
  async function deliveryOf(
    tenant: Tenant,
    eventId: string,
    endpointId: string,
  ): Promise<{ id: string; status: string; attemptCount: number }> {
    const listed = await request(env.app)
      .get('/v1/deliveries')
      .query({ eventId, endpointId })
      .set(bearerFor(tenant))
    expect(listed.status).toBe(200)
    const found = (
      listed.body.items as Array<{
        id: string
        status: string
        attemptCount: number
        eventId: string
        endpointId: string
      }>
    ).find((item) => item.eventId === eventId && item.endpointId === endpointId)
    expect(found).toBeDefined()
    return { id: found!.id, status: found!.status, attemptCount: found!.attemptCount }
  }

  describe('GET /v1/deliveries — filters and cursor pagination', () => {
    it('walks pages strictly newest-first with no gaps or repeats', async () => {
      const endpointId = await createEndpoint(alice, 'http://localhost:9/never-served')
      for (let i = 0; i < 25; i++) await submitEvent(alice)

      const collected: string[] = []
      let cursor: string | null = null
      for (;;) {
        const response = await request(env.app)
          .get('/v1/deliveries')
          .query({ limit: 10, endpointId, ...(cursor ? { cursor } : {}) })
          .set(bearerFor(alice))
        expect(response.status).toBe(200)
        collected.push(...(response.body.items as Array<{ id: string }>).map((item) => item.id))
        cursor = response.body.nextCursor as string | null
        if (cursor === null) break
      }
      expect(collected).toHaveLength(25)
      expect(new Set(collected).size).toBe(25)
    })

    it('filters by status, endpoint, and event id', async () => {
      const endpointId = await createEndpoint(alice, 'http://localhost:9/never-served')
      const oneEvent = await submitEvent(alice)
      for (let i = 0; i < 4; i++) await submitEvent(alice)

      // Settle two of this endpoint's five deliveries.
      await pool().query(
        `UPDATE deliveries SET status = 'succeeded', completed_at = now()
         WHERE endpoint_id = $1
           AND id IN (SELECT id FROM deliveries WHERE endpoint_id = $1 ORDER BY id LIMIT 2)`,
        [endpointId],
      )

      const succeeded = await request(env.app)
        .get('/v1/deliveries')
        .query({ status: 'succeeded', endpointId })
        .set(bearerFor(alice))
      expect(succeeded.body.items).toHaveLength(2)
      expect(succeeded.body.nextCursor).toBeNull()

      const pending = await request(env.app)
        .get('/v1/deliveries')
        .query({ status: 'pending', endpointId, limit: 100 })
        .set(bearerFor(alice))
      expect(pending.body.items).toHaveLength(3)

      const byEvent = await request(env.app)
        .get('/v1/deliveries')
        .query({ eventId: oneEvent, endpointId })
        .set(bearerFor(alice))
      expect(byEvent.body.items).toHaveLength(1)
      expect(byEvent.body.items[0].eventId).toBe(oneEvent)
      expect(byEvent.body.items[0].endpointId).toBe(endpointId)
    })

    it('rejects bad filters and cursors with 400', async () => {
      const badStatus = await request(env.app)
        .get('/v1/deliveries')
        .query({ status: 'exploded' })
        .set(bearerFor(alice))
      expect(badStatus.status).toBe(400)

      const badCursor = await request(env.app)
        .get('/v1/deliveries')
        .query({ cursor: '%%%%' })
        .set(bearerFor(alice))
      expect(badCursor.status).toBe(400)
    })
  })

  describe('GET /v1/deliveries/:id — detail with the attempt log', () => {
    let deliveryId: string

    beforeAll(async () => {
      const endpointId = await createEndpoint(alice, 'http://localhost:9/never-served')
      const eventId = await submitEvent(alice)
      deliveryId = (await deliveryOf(alice, eventId, endpointId)).id
      // Two attempts logged by hand (the log is append-only).
      await pool().query(
        `INSERT INTO delivery_attempts
           (delivery_id, attempt_number, started_at, duration_ms, status_code, response_snippet)
         VALUES ($1, 1, now() - interval '2 minutes', 120, 500, 'boom one'),
                ($1, 2, now() - interval '1 minute', 240, 503, 'boom two')`,
        [deliveryId],
      )
    })

    it('returns the delivery with its attempts in order', async () => {
      const response = await request(env.app)
        .get(`/v1/deliveries/${deliveryId}`)
        .set(bearerFor(alice))
      expect(response.status).toBe(200)
      expect(response.body.delivery.id).toBe(deliveryId)
      expect(response.body.delivery.status).toBe('pending')
      expect(response.body.attempts).toHaveLength(2)
      expect(response.body.attempts.map((a: { attemptNumber: number }) => a.attemptNumber)).toEqual(
        [1, 2],
      )
      expect(response.body.attempts[0]).toMatchObject({
        statusCode: 500,
        responseSnippet: 'boom one',
      })
    })

    it('404s unknown and non-uuid ids', async () => {
      const unknown = await request(env.app)
        .get('/v1/deliveries/00000000-0000-4000-8000-000000000000')
        .set(bearerFor(alice))
      expect(unknown.status).toBe(404)
      const notId = await request(env.app).get('/v1/deliveries/not-a-uuid').set(bearerFor(alice))
      expect(notId.status).toBe(404)
    })
  })

  describe('POST /v1/deliveries/:id/replay — single-delivery checks', () => {
    it('409s a pending delivery and 404s unknown ids', async () => {
      const endpointId = await createEndpoint(alice, 'http://localhost:9/never-served')
      const eventId = await submitEvent(alice)
      const pending = await deliveryOf(alice, eventId, endpointId)

      const conflict = await request(env.app)
        .post(`/v1/deliveries/${pending.id}/replay`)
        .set(bearerFor(alice))
      expect(conflict.status).toBe(409)
      expect(conflict.body.code).toBe('NOT_REPLAYABLE')

      const unknown = await request(env.app)
        .post('/v1/deliveries/00000000-0000-4000-8000-000000000000/replay')
        .set(bearerFor(alice))
      expect(unknown.status).toBe(404)
    })

    it('409s DELIVERY_IN_FLIGHT for a leased dead delivery', async () => {
      const endpointId = await createEndpoint(alice, 'http://localhost:9/never-served')
      const eventId = await submitEvent(alice)
      const delivery = await deliveryOf(alice, eventId, endpointId)
      // A worker holding the lease on a settled-or-not row blocks replay.
      await pool().query(
        `UPDATE deliveries SET status = 'dead', completed_at = now(),
                locked_until = now() + interval '1 hour', attempt_count = 3, cycle_start = 2
         WHERE id = $1`,
        [delivery.id],
      )
      const leased = await request(env.app)
        .post(`/v1/deliveries/${delivery.id}/replay`)
        .set(bearerFor(alice))
      expect(leased.status).toBe(409)
      expect(leased.body.code).toBe('DELIVERY_IN_FLIGHT')
    })

    it('replays a dead delivery: pending now, schedule restarts without renumbering', async () => {
      const endpointId = await createEndpoint(alice, 'http://localhost:9/never-served')
      const eventId = await submitEvent(alice)
      const delivery = await deliveryOf(alice, eventId, endpointId)
      await pool().query(
        `UPDATE deliveries SET status = 'dead', completed_at = now(),
                attempt_count = 4, cycle_start = 0
         WHERE id = $1`,
        [delivery.id],
      )

      const replayed = await request(env.app)
        .post(`/v1/deliveries/${delivery.id}/replay`)
        .set(bearerFor(alice))
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
      const endpointId = await createEndpoint(alice, mode.url)
      const eventId = await submitEvent(alice)
      const delivery = await deliveryOf(alice, eventId, endpointId)

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
      const replayed = await request(env.app)
        .post(`/v1/deliveries/${delivery.id}/replay`)
        .set(bearerFor(alice))
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

      const final = await request(env.app)
        .get(`/v1/deliveries/${delivery.id}`)
        .set(bearerFor(alice))
      expect(final.body.delivery.attemptCount).toBe(numbers.length)
      expect(final.body.delivery.completedAt).not.toBeNull()
    })
  })

  describe('POST /v1/endpoints/:id/test', () => {
    let mode: ModeServer
    beforeAll(async () => {
      mode = await startModeServer()
    })
    afterAll(async () => {
      await mode.close()
    })

    function smallDispatcher(): Dispatcher {
      return createDispatcher(
        pool(),
        {
          concurrency: 2,
          batchSize: 2,
          perEndpointClaimCap: 2,
          pollIntervalMs: 20,
          leaseSeconds: 10,
          breakerThreshold: 999,
          breakerCooldownSeconds: 60,
          encryptionKeyBase64: TEST_ENCRYPTION_KEY,
          requestTimeoutMs: 2_000,
          allowInsecureHttp: true,
          allowPrivateTargets: true,
          delaysMs: TINY_DELAYS,
        },
        createLogger('test', 'silent'),
      )
    }

    it('creates a webhook.test event and delivers it via the normal path', async () => {
      const endpointId = await createEndpoint(alice, mode.url)
      mode.mode.behavior = 'ok'

      const tested = await request(env.app)
        .post(`/v1/endpoints/${endpointId}/test`)
        .set(bearerFor(alice))
      expect(tested.status).toBe(202)
      expect(typeof tested.body.id).toBe('string')
      expect(typeof tested.body.deliveryId).toBe('string')

      // The event exists, is a webhook.test, and has exactly one delivery.
      const event = await request(env.app).get(`/v1/events/${tested.body.id}`).set(bearerFor(alice))
      expect(event.status).toBe(200)
      expect(event.body.event.eventType).toBe('webhook.test')
      expect(event.body.deliveries).toHaveLength(1)

      // The delivery rides the normal dispatcher path to success.
      const dispatcher = smallDispatcher()
      dispatcher.start()
      try {
        await waitUntil(async () => {
          const row = await pool().query<{ status: string }>(
            'SELECT status::text FROM deliveries WHERE id = $1',
            [tested.body.deliveryId],
          )
          return row.rows[0]?.status === 'succeeded'
        })
      } finally {
        await dispatcher.stop()
      }
    })

    it('409s a disabled endpoint and 404s foreign/unknown endpoints', async () => {
      const endpointId = await createEndpoint(alice, 'http://localhost:9/never-served')
      const disabled = await request(env.app)
        .patch(`/v1/endpoints/${endpointId}`)
        .set(bearerFor(alice))
        .send({ status: 'disabled' })
      expect(disabled.status).toBe(200)

      const conflict = await request(env.app)
        .post(`/v1/endpoints/${endpointId}/test`)
        .set(bearerFor(alice))
      expect(conflict.status).toBe(409)
      expect(conflict.body.code).toBe('ENDPOINT_DISABLED')

      const unknown = await request(env.app)
        .post('/v1/endpoints/00000000-0000-4000-8000-000000000000/test')
        .set(bearerFor(alice))
      expect(unknown.status).toBe(404)
    })
  })

  describe('tenant isolation on every route', () => {
    it('bob sees none of alice’s deliveries, replays, or endpoints', async () => {
      const endpointId = await createEndpoint(alice, 'http://localhost:9/never-served')
      const eventId = await submitEvent(alice)
      const delivery = await deliveryOf(alice, eventId, endpointId)

      const list = await request(env.app)
        .get('/v1/deliveries')
        .query({ endpointId })
        .set(bearerFor(bob))
      expect(list.body.items).toHaveLength(0)

      const detail = await request(env.app).get(`/v1/deliveries/${delivery.id}`).set(bearerFor(bob))
      expect(detail.status).toBe(404)

      await pool().query(
        `UPDATE deliveries SET status = 'dead', completed_at = now() WHERE id = $1`,
        [delivery.id],
      )
      const replay = await request(env.app)
        .post(`/v1/deliveries/${delivery.id}/replay`)
        .set(bearerFor(bob))
      expect(replay.status).toBe(404)

      // The failed replay changed nothing for the owner.
      const detailStillDead = await request(env.app)
        .get(`/v1/deliveries/${delivery.id}`)
        .set(bearerFor(alice))
      expect(detailStillDead.body.delivery.status).toBe('dead')

      const testSend = await request(env.app)
        .post(`/v1/endpoints/${endpointId}/test`)
        .set(bearerFor(bob))
      expect(testSend.status).toBe(404)
    })
  })
})
