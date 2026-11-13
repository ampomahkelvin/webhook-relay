import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createDispatcher, type Dispatcher } from '../../src/dispatcher/loop.js'
import { createLogger } from '../../src/logger.js'
import { startModeServer, type ModeServer } from '../helpers/mode-server.js'
import { startOpsContext, TINY_DELAYS, waitUntil, type OpsContext } from '../helpers/ops-context.js'
import { TEST_ENCRYPTION_KEY } from '../helpers/test-app.js'

/**
 * Operations API (PLAN phase 7 / DESIGN section 10): delivery listing with
 * filters and cursor pagination, detail with the attempt log, the endpoint
 * test-send, and tenant isolation on every route. The replay flows live in
 * `replay.test.ts`; the shared app/tenant setup is `helpers/ops-context.ts`.
 */
describe('operations API', () => {
  let ctx: OpsContext
  const alice = () => ctx.alice
  const bob = () => ctx.bob
  const env = () => ctx.env
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

  describe('GET /v1/deliveries — filters and cursor pagination', () => {
    it('walks pages strictly newest-first with no gaps or repeats', async () => {
      const endpointId = await createEndpoint(alice(), 'http://localhost:9/never-served')
      for (let i = 0; i < 25; i++) await submitEvent(alice())

      const collected: string[] = []
      let cursor: string | null = null
      for (;;) {
        const response = await request(env().app)
          .get('/v1/deliveries')
          .query({ limit: 10, endpointId, ...(cursor ? { cursor } : {}) })
          .set(bearerFor(alice()))
        expect(response.status).toBe(200)
        collected.push(...(response.body.items as Array<{ id: string }>).map((item) => item.id))
        cursor = response.body.nextCursor as string | null
        if (cursor === null) break
      }
      expect(collected).toHaveLength(25)
      expect(new Set(collected).size).toBe(25)
    })

    it('filters by status, endpoint, and event id', async () => {
      const endpointId = await createEndpoint(alice(), 'http://localhost:9/never-served')
      const oneEvent = await submitEvent(alice())
      for (let i = 0; i < 4; i++) await submitEvent(alice())

      // Settle two of this endpoint's five deliveries.
      await pool().query(
        `UPDATE deliveries SET status = 'succeeded', completed_at = now()
         WHERE endpoint_id = $1
           AND id IN (SELECT id FROM deliveries WHERE endpoint_id = $1 ORDER BY id LIMIT 2)`,
        [endpointId],
      )

      const succeeded = await request(env().app)
        .get('/v1/deliveries')
        .query({ status: 'succeeded', endpointId })
        .set(bearerFor(alice()))
      expect(succeeded.body.items).toHaveLength(2)
      expect(succeeded.body.nextCursor).toBeNull()

      const pending = await request(env().app)
        .get('/v1/deliveries')
        .query({ status: 'pending', endpointId, limit: 100 })
        .set(bearerFor(alice()))
      expect(pending.body.items).toHaveLength(3)

      const byEvent = await request(env().app)
        .get('/v1/deliveries')
        .query({ eventId: oneEvent, endpointId })
        .set(bearerFor(alice()))
      expect(byEvent.body.items).toHaveLength(1)
      expect(byEvent.body.items[0].eventId).toBe(oneEvent)
      expect(byEvent.body.items[0].endpointId).toBe(endpointId)
    })

    it('rejects bad filters and cursors with 400', async () => {
      const badStatus = await request(env().app)
        .get('/v1/deliveries')
        .query({ status: 'exploded' })
        .set(bearerFor(alice()))
      expect(badStatus.status).toBe(400)

      const badCursor = await request(env().app)
        .get('/v1/deliveries')
        .query({ cursor: '%%%%' })
        .set(bearerFor(alice()))
      expect(badCursor.status).toBe(400)
    })
  })

  describe('GET /v1/deliveries/:id — detail with the attempt log', () => {
    let deliveryId: string

    beforeAll(async () => {
      const endpointId = await createEndpoint(alice(), 'http://localhost:9/never-served')
      const eventId = await submitEvent(alice())
      deliveryId = (await deliveryOf(alice(), eventId, endpointId)).id
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
      const response = await request(env().app)
        .get(`/v1/deliveries/${deliveryId}`)
        .set(bearerFor(alice()))
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
      const unknown = await request(env().app)
        .get('/v1/deliveries/00000000-0000-4000-8000-000000000000')
        .set(bearerFor(alice()))
      expect(unknown.status).toBe(404)
      const notId = await request(env().app)
        .get('/v1/deliveries/not-a-uuid')
        .set(bearerFor(alice()))
      expect(notId.status).toBe(404)
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
      const endpointId = await createEndpoint(alice(), mode.url)
      mode.mode.behavior = 'ok'

      const tested = await request(env().app)
        .post(`/v1/endpoints/${endpointId}/test`)
        .set(bearerFor(alice()))
      expect(tested.status).toBe(202)
      expect(typeof tested.body.id).toBe('string')
      expect(typeof tested.body.deliveryId).toBe('string')

      // The event exists, is a webhook.test, and has exactly one delivery.
      const event = await request(env().app)
        .get(`/v1/events/${tested.body.id}`)
        .set(bearerFor(alice()))
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
      const endpointId = await createEndpoint(alice(), 'http://localhost:9/never-served')
      const disabled = await request(env().app)
        .patch(`/v1/endpoints/${endpointId}`)
        .set(bearerFor(alice()))
        .send({ status: 'disabled' })
      expect(disabled.status).toBe(200)

      const conflict = await request(env().app)
        .post(`/v1/endpoints/${endpointId}/test`)
        .set(bearerFor(alice()))
      expect(conflict.status).toBe(409)
      expect(conflict.body.code).toBe('ENDPOINT_DISABLED')

      const unknown = await request(env().app)
        .post('/v1/endpoints/00000000-0000-4000-8000-000000000000/test')
        .set(bearerFor(alice()))
      expect(unknown.status).toBe(404)
    })

    it('event detail renders deliveries in the shared list shape', async () => {
      const endpointId = await createEndpoint(alice(), mode.url)
      mode.mode.behavior = 'ok'

      const tested = await request(env().app)
        .post(`/v1/endpoints/${endpointId}/test`)
        .set(bearerFor(alice()))
      expect(tested.status).toBe(202)

      const event = await request(env().app)
        .get(`/v1/events/${tested.body.id}`)
        .set(bearerFor(alice()))
      expect(event.status).toBe(200)
      // A tenant event fans out to every enabled endpoint; pin the shape of
      // THIS test's delivery, whatever its position in the list.
      const mine = (event.body.deliveries as Array<Record<string, unknown>>).find(
        (d) => d.endpointId === endpointId,
      )
      expect(mine).toBeDefined()
      expect(mine).toMatchObject({
        id: tested.body.deliveryId,
        status: 'pending',
        attemptCount: expect.any(Number),
        cycleStart: expect.any(Number),
        createdAt: expect.any(String),
      })
      expect(mine).toHaveProperty('nextAttemptAt')
    })
  })

  describe('tenant isolation on every route', () => {
    it('bob sees none of alice’s deliveries, replays, or endpoints', async () => {
      const endpointId = await createEndpoint(alice(), 'http://localhost:9/never-served')
      const eventId = await submitEvent(alice())
      const delivery = await deliveryOf(alice(), eventId, endpointId)

      const list = await request(env().app)
        .get('/v1/deliveries')
        .query({ endpointId })
        .set(bearerFor(bob()))
      expect(list.body.items).toHaveLength(0)

      const detail = await request(env().app)
        .get(`/v1/deliveries/${delivery.id}`)
        .set(bearerFor(bob()))
      expect(detail.status).toBe(404)

      await pool().query(
        `UPDATE deliveries SET status = 'dead', completed_at = now() WHERE id = $1`,
        [delivery.id],
      )
      const replay = await request(env().app)
        .post(`/v1/deliveries/${delivery.id}/replay`)
        .set(bearerFor(bob()))
      expect(replay.status).toBe(404)

      // The failed replay changed nothing for the owner.
      const detailStillDead = await request(env().app)
        .get(`/v1/deliveries/${delivery.id}`)
        .set(bearerFor(alice()))
      expect(detailStillDead.body.delivery.status).toBe('dead')

      const testSend = await request(env().app)
        .post(`/v1/endpoints/${endpointId}/test`)
        .set(bearerFor(bob()))
      expect(testSend.status).toBe(404)
    })
  })
})
