import request from 'supertest'
import type { Pool } from 'pg'
import type { TestApp } from './test-app.js'
import { startTestApp, TEST_ADMIN_KEY } from './test-app.js'

/**
 * The shared operations-API context: a running test app plus two tenants,
 * and the tiny helpers every operations/replay test leans on (create an
 * endpoint through the API so URLs validate like production, submit an
 * event, find one endpoint's delivery of an event).
 *
 * Concurrency note: an event fans out to EVERY enabled endpoint of its
 * tenant, so every test scopes its queries by the endpoint it created —
 * sibling endpoints from other tests share the tenant.
 */

export const TINY_DELAYS = Array.from({ length: 8 }, () => 10)

export async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error('waitUntil: condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}

export interface Tenant {
  id: string
  apiKey: string
}

export interface OpsContext {
  env: TestApp
  alice: Tenant
  bob: Tenant
  pool: () => Pool
  bearerFor: (tenant: Tenant) => Record<string, string>
  /** Create a real endpoint through the API (URL validates like production). */
  createEndpoint: (tenant: Tenant, url: string) => Promise<string>
  /** Submit an event through intake; every enabled endpoint gets one delivery. */
  submitEvent: (tenant: Tenant, eventType?: string) => Promise<string>
  /** The delivery of an event for one specific endpoint. */
  deliveryOf: (
    tenant: Tenant,
    eventId: string,
    endpointId: string,
  ) => Promise<{ id: string; status: string; attemptCount: number }>
}

export async function startOpsContext(): Promise<OpsContext> {
  // Cap is high (and not under test here — endpoints.test.ts pins the
  // limit behavior): every test creates its own endpoint under the shared
  // tenant, and the count must never gate a test.
  const env = await startTestApp({ maxEndpointsPerTenant: 20, allowInsecureHttp: true })
  const tenants: Tenant[] = []
  for (const name of ['alice-ops', 'bob-ops']) {
    const response = await request(env.app)
      .post('/admin/tenants')
      .set({ Authorization: `Bearer ${TEST_ADMIN_KEY}` })
      .send({ name })
    expect(response.status).toBe(201)
    tenants.push({ id: response.body.tenant.id, apiKey: response.body.apiKey.key })
  }
  const [alice, bob] = tenants as [Tenant, Tenant]

  let counter = 0
  const bearerFor = (tenant: Tenant) => ({ Authorization: `Bearer ${tenant.apiKey}` })

  async function createEndpoint(tenant: Tenant, url: string): Promise<string> {
    const response = await request(env.app)
      .post('/v1/endpoints')
      .set(bearerFor(tenant))
      .send({ url, eventTypes: ['*'] })
    expect(response.status).toBe(201)
    return response.body.endpoint.id as string
  }

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

  return {
    env,
    alice,
    bob,
    pool: () => env.db.pool,
    bearerFor,
    createEndpoint,
    submitEvent,
    deliveryOf,
  }
}
