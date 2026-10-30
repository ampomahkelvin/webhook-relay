import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import {
  startTestApp,
  TEST_ADMIN_KEY,
  TEST_ENCRYPTION_KEY,
  type TestApp,
} from '../helpers/test-app.js'
import { createApp } from '../../src/api/app.js'
import { createLogger } from '../../src/logger.js'

let env: TestApp
let stableApp: ReturnType<typeof createApp> // same pool, tiny rate bucket
beforeAll(async () => {
  env = await startTestApp()
  stableApp = createApp({
    pool: env.db.pool,
    logger: createLogger('test', 'silent'),
    adminApiKey: TEST_ADMIN_KEY,
    maxEndpointsPerTenant: 20,
    allowInsecureHttp: false,
    encryptionKey: TEST_ENCRYPTION_KEY,
    intake: { ratePerMinute: 0, burst: 2 },
  })
})
afterAll(() => env.stop())

const admin = () => request(env.app)
const bearer = (key: string) => ({ Authorization: `Bearer ${key}` })

interface Tenant {
  id: string
  apiKey: string
}

async function createTenant(name: string): Promise<Tenant> {
  const response = await admin().post('/admin/tenants').set(bearer(TEST_ADMIN_KEY)).send({ name })
  return { id: response.body.tenant.id as string, apiKey: response.body.apiKey.key as string }
}

async function createEndpoint(
  tenant: Tenant,
  body: Record<string, unknown> = { url: 'https://receiver.example.com/hook', eventTypes: ['*'] },
): Promise<{ id: string; status: number }> {
  const response = await admin().post('/v1/endpoints').set(bearer(tenant.apiKey)).send(body)
  return { id: response.body?.endpoint?.id as string, status: response.status }
}

const BODY = { eventType: 'invoice.paid', payload: { amount: 42, currency: 'USD' } }

function submit(tenant: Tenant, body: Record<string, unknown> = BODY, key = 'order-1') {
  return admin()
    .post('/v1/events')
    .set(bearer(tenant.apiKey))
    .set('Idempotency-Key', key)
    .send(body)
}

describe('event intake fan-out', () => {
  it('creates one delivery per matching enabled endpoint in one request', async () => {
    const tenant = await createTenant('intake-fanout')
    expect(
      (await createEndpoint(tenant, { url: 'https://a.example.com', eventTypes: ['*'] })).status,
    ).toBe(201)
    expect(
      (await createEndpoint(tenant, { url: 'https://b.example.com', eventTypes: ['invoice.paid'] }))
        .status,
    ).toBe(201)
    // exact-match endpoint that does NOT match
    expect(
      (
        await createEndpoint(tenant, {
          url: 'https://c.example.com',
          eventTypes: ['invoice.refunded'],
        })
      ).status,
    ).toBe(201)
    // disabled endpoint that matches
    const disabled = await createEndpoint(tenant, {
      url: 'https://d.example.com',
      eventTypes: ['*'],
    })
    await admin()
      .patch(`/v1/endpoints/${disabled.id}`)
      .set(bearer(tenant.apiKey))
      .send({ status: 'disabled' })

    const response = await submit(tenant)
    expect(response.status).toBe(202)
    expect(response.get('Idempotent-Replayed')).toBeUndefined()
    expect(response.body.deliveries).toBe(2) // wildcard + exact; disabled and non-matching skipped

    const detail = await admin().get(`/v1/events/${response.body.id}`).set(bearer(tenant.apiKey))
    expect(detail.status).toBe(200)
    expect(detail.body.event.eventType).toBe('invoice.paid')
    expect(detail.body.event.payload).toEqual(BODY.payload)
    const endpoints = (detail.body.deliveries as Array<{ endpointId: string }>).map(
      (d) => d.endpointId,
    )
    expect(endpoints).toHaveLength(2)
    expect(endpoints).not.toContain(disabled.id)
    for (const delivery of detail.body.deliveries as Array<{
      status: string
      attemptCount: number
    }>) {
      expect(delivery.status).toBe('pending')
      expect(delivery.attemptCount).toBe(0)
    }
  })

  it('rejects malformed intake requests', async () => {
    const tenant = await createTenant('intake-validate')

    const noKey = await submit(tenant, BODY, '')
    expect(noKey.status).toBe(400)
    expect(noKey.body.code).toBe('VALIDATION_ERROR')

    const longKey = await admin()
      .post('/v1/events')
      .set(bearer(tenant.apiKey))
      .set('Idempotency-Key', 'x'.repeat(201))
      .send(BODY)
    expect(longKey.status).toBe(400)

    const badType = await submit(tenant, { eventType: 'INVOICE.PAID', payload: {} })
    expect(badType.status).toBe(400)

    const emptyType = await submit(tenant, { eventType: '', payload: {} })
    expect(emptyType.status).toBe(400)

    const arrayPayload = await submit(tenant, { eventType: 'invoice.paid', payload: [1, 2] })
    expect(arrayPayload.status).toBe(400)

    const oversize = await submit(tenant, {
      eventType: 'invoice.paid',
      payload: { blob: 'x'.repeat(256 * 1024 + 1) },
    })
    expect(oversize.status).toBe(413)
    expect(oversize.body.code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('enforces the per-tenant rate limit with Retry-After', async () => {
    const tenant = await createTenant('intake-ratelimit')

    // two tokens, no refill → third request is 429
    await request(stableApp)
      .post('/v1/events')
      .set(bearer(tenant.apiKey))
      .set('Idempotency-Key', 'r1')
      .send(BODY)
    await request(stableApp)
      .post('/v1/events')
      .set(bearer(tenant.apiKey))
      .set('Idempotency-Key', 'r2')
      .send(BODY)
    const third = await request(stableApp)
      .post('/v1/events')
      .set(bearer(tenant.apiKey))
      .set('Idempotency-Key', 'r3')
      .send(BODY)
    expect(third.status).toBe(429)
    expect(third.body.code).toBe('RATE_LIMITED')
    expect(Number(third.get('Retry-After'))).toBeGreaterThanOrEqual(1)

    // a different tenant is unaffected
    const other = await createTenant('intake-ratelimit-other')
    const ok = await request(stableApp)
      .post('/v1/events')
      .set(bearer(other.apiKey))
      .set('Idempotency-Key', 'r1')
      .send(BODY)
    expect(ok.status).toBe(202)
  })
})

describe('idempotent replay', () => {
  it('replays the same key and request as the original result', async () => {
    const tenant = await createTenant('intake-replay')

    const first = await submit(tenant)
    expect(first.status).toBe(202)
    const eventId = first.body.id as string
    const count = first.body.deliveries as number

    // payload key order must not matter
    const reordered = await submit(
      tenant,
      { payload: { currency: 'USD', amount: 42 }, eventType: 'invoice.paid' },
      'order-1',
    )
    expect(reordered.status).toBe(202)
    expect(reordered.get('Idempotent-Replayed')).toBe('true')
    expect(reordered.body.id).toBe(eventId)

    // and the deliveries are untouched
    const detail = await admin().get(`/v1/events/${eventId}`).set(bearer(tenant.apiKey))
    expect((detail.body.deliveries as unknown[]).length).toBe(count)
  })

  it('rejects a replayed key with a different request', async () => {
    const tenant = await createTenant('intake-mismatch')
    await submit(tenant, BODY, 'key-42')

    const different = await submit(
      tenant,
      { eventType: 'invoice.paid', payload: { amount: 43, currency: 'USD' } },
      'key-42',
    )
    expect(different.status).toBe(422)
    expect(different.body.code).toBe('IDEMPOTENCY_KEY_REUSED')

    const differentType = await submit(tenant, { ...BODY, eventType: 'invoice.refunded' }, 'key-42')
    expect(differentType.status).toBe(422)
  })

  it('coalesces 50 parallel same-key submissions into one event', async () => {
    const tenant = await createTenant('intake-parallel')
    expect(
      (await createEndpoint(tenant, { url: 'https://p1.example.com', eventTypes: ['*'] })).status,
    ).toBe(201)
    expect(
      (await createEndpoint(tenant, { url: 'https://p2.example.com', eventTypes: ['*'] })).status,
    ).toBe(201)

    const submissions = Array.from({ length: 50 }, () => submit(tenant, BODY, 'same-key'))
    const responses = await Promise.all(submissions)

    for (const response of responses) expect(response.status).toBe(202)
    const eventIds = new Set(responses.map((r) => r.body.id as string))
    expect(eventIds.size).toBe(1)

    // exactly one delivery per endpoint
    const detail = await admin()
      .get(`/v1/events/${[...eventIds][0]}`)
      .set(bearer(tenant.apiKey))
    expect((detail.body.deliveries as unknown[]).length).toBe(2)
  })
})

describe('intake atomicity', () => {
  it('leaves nothing behind when the fan-out insert fails', async () => {
    const tenant = await createTenant('intake-fault')
    expect(
      (await createEndpoint(tenant, { url: 'https://f.example.com', eventTypes: ['*'] })).status,
    ).toBe(201)

    // Inject a fault inside the statement: deliveries insert raises, so
    // the whole statement — event included — must roll back.
    await env.db.pool.query(`
      CREATE OR REPLACE FUNCTION intake_test_boom() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END;
      $$ LANGUAGE plpgsql`)
    await env.db.pool.query(
      'CREATE TRIGGER intake_test_boom_t AFTER INSERT ON deliveries FOR EACH ROW EXECUTE FUNCTION intake_test_boom()',
    )
    try {
      const failed = await submit(tenant, BODY, 'fault-key')
      expect(failed.status).toBe(500)

      const counts = await env.db.pool.query<{ events: string; deliveries: string }>(
        `SELECT (SELECT count(*) FROM events WHERE tenant_id = $1) AS events,
                (SELECT count(*) FROM deliveries d
                  JOIN endpoints ep ON ep.id = d.endpoint_id
                  WHERE ep.tenant_id = $1) AS deliveries`,
        [tenant.id],
      )
      expect(Number(counts.rows[0]?.events)).toBe(0)
      expect(Number(counts.rows[0]?.deliveries)).toBe(0)
    } finally {
      await env.db.pool.query('DROP TRIGGER intake_test_boom_t ON deliveries')
      await env.db.pool.query('DROP FUNCTION intake_test_boom()')
    }

    // the idempotency key is free: a clean resubmission succeeds
    const recovered = await submit(tenant, BODY, 'fault-key')
    expect(recovered.status).toBe(202)
    expect(recovered.body.deliveries).toBe(1)
  })
})
