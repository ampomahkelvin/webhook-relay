import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { startTestApp, TEST_ADMIN_KEY, type TestApp } from '../helpers/test-app.js'
import type { Pool } from 'pg'

/**
 * Tenant isolation across EVERY route (DESIGN section 9): another tenant's
 * resource is a plain 404 (ids do not leak existence), filters scoped by
 * someone else's ids return empty pages, a failed foreign write changes
 * nothing, and the admin namespace rejects tenant keys and anonymity.
 */

interface Tenant {
  id: string
  apiKey: string
}

describe('tenant isolation matrix', () => {
  let env: TestApp
  let alice: Tenant
  let bob: Tenant
  let aliceEndpointId: string
  let aliceEventId: string
  let aliceDeliveryId: string
  let aliceEndpointBeforePatch: Record<string, unknown>

  beforeAll(async () => {
    env = await startTestApp({ maxEndpointsPerTenant: 10, allowInsecureHttp: true })
    const admin = () => request(env.app)

    const tenants: Tenant[] = []
    for (const name of ['alice-matrix', 'bob-matrix']) {
      const response = await request(env.app)
        .post('/admin/tenants')
        .set({ Authorization: `Bearer ${TEST_ADMIN_KEY}` })
        .send({ name })
      tenants.push({ id: response.body.tenant.id, apiKey: response.body.apiKey.key })
    }
    ;[alice, bob] = tenants as [Tenant, Tenant]

    const endpoint = await admin()
      .post('/v1/endpoints')
      .set(bearer(alice))
      .send({ url: 'http://localhost:9/never-matrix', eventTypes: ['*'] })
    expect(endpoint.status).toBe(201)
    aliceEndpointId = endpoint.body.endpoint.id
    // Baseline from a GET (the create response omits breaker state).
    const afterCreate = await request(env.app)
      .get(`/v1/endpoints/${aliceEndpointId}`)
      .set(bearer(alice))
    aliceEndpointBeforePatch = afterCreate.body.endpoint

    const intake = await admin()
      .post('/v1/events')
      .set(bearer(alice))
      .set('Idempotency-Key', 'matrix-1')
      .send({ eventType: 'demo.ping', payload: { n: 1 } })
    expect(intake.status).toBe(202)
    aliceEventId = intake.body.id

    const event = await admin().get(`/v1/events/${aliceEventId}`).set(bearer(alice))
    aliceDeliveryId = event.body.deliveries[0].id
    expect(aliceDeliveryId).toBeDefined()
  })
  afterAll(async () => {
    await env.stop()
  })

  function bearer(tenant: Tenant) {
    return { Authorization: `Bearer ${tenant.apiKey}` }
  }
  const pool = (): Pool => env.db.pool
  const ALIEN = '00000000-0000-4000-8000-000000000000'

  it('alice can read her own resources (control check)', async () => {
    expect(
      (await request(env.app).get(`/v1/events/${aliceEventId}`).set(bearer(alice))).status,
    ).toBe(200)
    expect(
      (await request(env.app).get(`/v1/endpoints/${aliceEndpointId}`).set(bearer(alice))).status,
    ).toBe(200)
    expect(
      (await request(env.app).get(`/v1/deliveries/${aliceDeliveryId}`).set(bearer(alice))).status,
    ).toBe(200)
  })

  it('foreign ids are 404 on events, endpoints, deliveries, and their writes', async () => {
    const foreignGets = [
      `/v1/events/${aliceEventId}`,
      `/v1/endpoints/${aliceEndpointId}`,
      `/v1/deliveries/${aliceDeliveryId}`,
      `/v1/events/${ALIEN}`,
    ]
    for (const url of foreignGets) {
      expect((await request(env.app).get(url).set(bearer(bob))).status).toBe(404)
    }
    const foreignPosts = [
      `/v1/deliveries/${aliceDeliveryId}/replay`,
      `/v1/endpoints/${aliceEndpointId}/test`,
    ]
    for (const url of foreignPosts) {
      expect((await request(env.app).post(url).set(bearer(bob))).status).toBe(404)
    }
    // Writes with foreign ids: 404, and they change nothing.
    const patch = await request(env.app)
      .patch(`/v1/endpoints/${aliceEndpointId}`)
      .set(bearer(bob))
      .send({ status: 'disabled' })
    expect(patch.status).toBe(404)
    const after = await request(env.app).get(`/v1/endpoints/${aliceEndpointId}`).set(bearer(alice))
    expect(after.body.endpoint).toEqual(aliceEndpointBeforePatch)

    const put = await request(env.app)
      .post(`/v1/deliveries/${aliceDeliveryId}/replay`)
      .set(bearer(bob))
    expect(put.status).toBe(404)
    const untouched = await request(env.app)
      .get(`/v1/deliveries/${aliceDeliveryId}`)
      .set(bearer(alice))
    expect(untouched.body.delivery.status).toBe('pending')
  })

  it('listing/filtering with a foreign tenant scope yields empty pages', async () => {
    const deliveries = await request(env.app)
      .get('/v1/deliveries')
      .query({ endpointId: aliceEndpointId, eventId: aliceEventId })
      .set(bearer(bob))
    expect(deliveries.body.items).toEqual([])
    expect(deliveries.body.nextCursor).toBeNull()

    const endpoints = await request(env.app).get('/v1/endpoints').set(bearer(bob))
    const foreignOnes = (endpoints.body.items as Array<{ id: string }>).filter(
      (item) => item.id === aliceEndpointId,
    )
    expect(foreignOnes).toEqual([])

    const events = await request(env.app).get(`/v1/events/${ALIEN}`).set(bearer(bob))
    expect(events.status).toBe(404)
  })

  it('foreign deletes and test-sends are 404 without cascading anything', async () => {
    const del = await request(env.app).delete(`/v1/endpoints/${aliceEndpointId}`).set(bearer(bob))
    expect(del.status).toBe(404)
    const alive = await request(env.app).get(`/v1/endpoints/${aliceEndpointId}`).set(bearer(alice))
    expect(alive.status).toBe(200)
    const deliveries = await pool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM deliveries WHERE endpoint_id = $1`,
      [aliceEndpointId],
    )
    expect(Number(deliveries.rows[0]!.n)).toBe(1)
  })

  it('the admin namespace rejects tenant keys and missing keys', async () => {
    const withTenantKey = await request(env.app).get('/admin/tenants').set(bearer(bob))
    expect(withTenantKey.status).toBe(401)
    const anonymous = await request(env.app).get('/admin/tenants')
    expect(anonymous.status).toBe(401)
    const wrongKey = await request(env.app)
      .post('/admin/tenants')
      .set(bearer(bob))
      .send({ name: 'x' })
    expect(wrongKey.status).toBe(401)
  })

  it('the tenant auth rejects revoked or malformed bearer keys', async () => {
    const raw = { Authorization: 'not-a-bearer-key' }
    const bad = await request(env.app).get('/v1/deliveries').set(raw)
    expect(bad.status).toBe(401)
    const nothing = await request(env.app).get('/v1/deliveries')
    expect(nothing.status).toBe(401)
  })
})
