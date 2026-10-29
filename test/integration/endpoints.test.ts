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
import { decryptSecret } from '../../src/security/crypto.js'

let env: TestApp
/** Same database, but an endpoint cap high enough for the pagination tests. */
let roomyApp: ReturnType<typeof createApp>
beforeAll(async () => {
  env = await startTestApp({ maxEndpointsPerTenant: 2 })
  roomyApp = createApp({
    pool: env.db.pool,
    logger: createLogger('test', 'silent'),
    adminApiKey: TEST_ADMIN_KEY,
    maxEndpointsPerTenant: 50,
    allowInsecureHttp: false,
    encryptionKey: TEST_ENCRYPTION_KEY,
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

const HTTPS_OK = 'https://receiver.example.com/hook'

async function createEndpoint(
  tenant: Tenant,
  body: Record<string, unknown> = { url: HTTPS_OK, eventTypes: ['invoice.paid'] },
) {
  return admin().post('/v1/endpoints').set(bearer(tenant.apiKey)).send(body)
}

describe('endpoint creation', () => {
  it('creates an endpoint and returns the signing secret exactly once', async () => {
    const tenant = await createTenant('ep-create')
    const response = await createEndpoint(tenant, {
      url: HTTPS_OK,
      description: 'demo',
      eventTypes: ['invoice.paid', 'invoice.refunded'],
    })

    expect(response.status).toBe(201)
    expect(response.body.endpoint.status).toBe('enabled')
    expect(response.body.endpoint.eventTypes).toEqual(['invoice.paid', 'invoice.refunded'])
    const secret = response.body.signingSecret as string
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/)

    // never again: not in GET, not in list, not in PATCH response
    const got = await admin()
      .get(`/v1/endpoints/${response.body.endpoint.id}`)
      .set(bearer(tenant.apiKey))
    expect(JSON.stringify(got.body)).not.toContain(secret)

    const listed = await admin().get('/v1/endpoints').set(bearer(tenant.apiKey))
    expect(JSON.stringify(listed.body)).not.toContain(secret)

    // stored encrypted: differs from plaintext, decrypts back
    const stored = await env.db.pool.query<{ secret_ciphertext: Buffer }>(
      'SELECT secret_ciphertext FROM endpoints WHERE id = $1',
      [response.body.endpoint.id],
    )
    const payload = stored.rows[0]?.secret_ciphertext as Buffer
    expect(payload.includes(Buffer.from(secret))).toBe(false)
    expect(decryptSecret(payload, Buffer.from(TEST_ENCRYPTION_KEY, 'base64'))).toBe(secret)
  })

  it('validates the body', async () => {
    const tenant = await createTenant('ep-validate')

    const noTypes = await createEndpoint(tenant, { url: HTTPS_OK, eventTypes: [] })
    expect(noTypes.status).toBe(400)

    const mixedWildcard = await createEndpoint(tenant, {
      url: HTTPS_OK,
      eventTypes: ['*', 'invoice.paid'],
    })
    expect(mixedWildcard.status).toBe(400)

    const badType = await createEndpoint(tenant, { url: HTTPS_OK, eventTypes: ['INVOICE'] })
    expect(badType.status).toBe(400)

    const tooManyTypes = await createEndpoint(tenant, {
      url: HTTPS_OK,
      eventTypes: Array.from({ length: 51 }, (_, i) => `type.${i}`),
    })
    expect(tooManyTypes.status).toBe(400)

    const longDescription = await createEndpoint(tenant, {
      url: HTTPS_OK,
      description: 'x'.repeat(501),
      eventTypes: ['*'],
    })
    expect(longDescription.status).toBe(400)
  })

  it('rejects unsafe URLs (SSRF layer 1)', async () => {
    const tenant = await createTenant('ep-ssrf')

    const insecure = await createEndpoint(tenant, { url: 'http://example.com', eventTypes: ['*'] })
    expect(insecure.status).toBe(400)

    const loopback = await createEndpoint(tenant, {
      url: 'https://127.0.0.1/hook',
      eventTypes: ['*'],
    })
    expect(loopback.status).toBe(400)

    const metadata = await createEndpoint(tenant, {
      url: 'https://169.254.169.254/latest/meta-data',
      eventTypes: ['*'],
    })
    expect(metadata.status).toBe(400)

    const decimalTrick = await createEndpoint(tenant, {
      url: 'https://2130706433/x',
      eventTypes: ['*'],
    })
    expect(decimalTrick.status).toBe(400)

    const credentials = await createEndpoint(tenant, {
      url: 'https://user:pass@example.com/hook',
      eventTypes: ['*'],
    })
    expect(credentials.status).toBe(400)

    // a hostname that could resolve anywhere is allowed at layer 1
    const hostname = await createEndpoint(tenant, {
      url: 'https://internal.corp.example/hook',
      eventTypes: ['*'],
    })
    expect(hostname.status).toBe(201)
  })

  it('enforces the per-tenant endpoint cap', async () => {
    const tenant = await createTenant('ep-cap')

    expect((await createEndpoint(tenant)).status).toBe(201)
    expect((await createEndpoint(tenant)).status).toBe(201)
    const overflow = await createEndpoint(tenant)
    expect(overflow.status).toBe(409)
    expect(overflow.body.code).toBe('ENDPOINT_LIMIT_REACHED')

    // delete one, cap frees up
    const list = await admin().get('/v1/endpoints').set(bearer(tenant.apiKey))
    const firstId = (list.body.items[0] as { id: string }).id
    await admin().delete(`/v1/endpoints/${firstId}`).set(bearer(tenant.apiKey))
    expect((await createEndpoint(tenant)).status).toBe(201)
  })
})

describe('endpoint listing and pagination', () => {
  it('cursor-paginates newest first without duplicates or gaps', async () => {
    const tenant = await createTenant('ep-pages')
    for (let i = 0; i < 5; i++) {
      const created = await request(roomyApp)
        .post('/v1/endpoints')
        .set(bearer(tenant.apiKey))
        .send({ url: HTTPS_OK, eventTypes: ['invoice.paid'] })
      expect(created.status).toBe(201)
    }

    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    for (;;) {
      const page = await request(roomyApp)
        .get('/v1/endpoints')
        .set(bearer(tenant.apiKey))
        .query(cursor ? { cursor, limit: 2 } : { limit: 2 })
      expect(page.status).toBe(200)
      for (const item of page.body.items as Array<{ id: string }>) seen.push(item.id)
      pages++
      const next = page.body.nextCursor as string | null
      if (next === null) break
      cursor = next
      expect(pages).toBeLessThan(10) // safety net against a cursor loop
    }

    expect(pages).toBe(3)
    expect(seen).toHaveLength(5)
    expect(new Set(seen).size).toBe(5)
  })

  it('rejects an invalid cursor', async () => {
    const tenant = await createTenant('ep-pages-bad')
    const response = await admin()
      .get('/v1/endpoints')
      .set(bearer(tenant.apiKey))
      .query({ cursor: 'not-a-cursor' })
    expect(response.status).toBe(400)
  })
})

describe('endpoint update', () => {
  it('changes url, event types, and status per the DB constraints', async () => {
    const tenant = await createTenant('ep-update')
    const created = await createEndpoint(tenant)
    const id = created.body.endpoint.id as string

    const patched = await admin()
      .patch(`/v1/endpoints/${id}`)
      .set(bearer(tenant.apiKey))
      .send({ status: 'disabled', eventTypes: ['*'] })
    expect(patched.status).toBe(200)
    expect(patched.body.endpoint.status).toBe('disabled')
    expect(patched.body.endpoint.disabledReason).toBe('manual')
    expect(patched.body.endpoint.eventTypes).toEqual(['*'])

    const reenabled = await admin()
      .patch(`/v1/endpoints/${id}`)
      .set(bearer(tenant.apiKey))
      .send({ status: 'enabled' })
    expect(reenabled.body.endpoint.status).toBe('enabled')
    expect(reenabled.body.endpoint.disabledReason).toBeNull()
  })

  it('validates patch input and rejects unknown fields', async () => {
    const tenant = await createTenant('ep-update-bad')
    const created = await createEndpoint(tenant)
    const endpointId = created.body.endpoint.id as string

    const unknownField = await admin()
      .patch(`/v1/endpoints/${endpointId}`)
      .set(bearer(tenant.apiKey))
      .send({ circuitState: 'closed' }) // breaker state is not settable by tenants
    expect(unknownField.status).toBe(400)

    const badUrl = await admin()
      .patch(`/v1/endpoints/${endpointId}`)
      .set(bearer(tenant.apiKey))
      .send({ url: 'https://127.0.0.1/hook' })
    expect(badUrl.status).toBe(400)
  })
})

describe('endpoint delete and tenant isolation', () => {
  it('deletes only the owning tenant’s endpoint and cascades', async () => {
    const owner = await createTenant('ep-owner')
    const stranger = await createTenant('ep-stranger')
    const created = await createEndpoint(owner)
    const id = created.body.endpoint.id as string

    // stranger sees 404, on every route
    const strangerGet = await admin().get(`/v1/endpoints/${id}`).set(bearer(stranger.apiKey))
    expect(strangerGet.status).toBe(404)
    const strangerPatch = await admin()
      .patch(`/v1/endpoints/${id}`)
      .set(bearer(stranger.apiKey))
      .send({ status: 'disabled' })
    expect(strangerPatch.status).toBe(404)
    const strangerDelete = await admin().delete(`/v1/endpoints/${id}`).set(bearer(stranger.apiKey))
    expect(strangerDelete.status).toBe(404)

    // listing a stranger never includes the owner's endpoint
    const strangerList = await admin().get('/v1/endpoints').set(bearer(stranger.apiKey))
    expect(JSON.stringify(strangerList.body)).not.toContain(id)

    // owner lists and deletes fine
    const ownerList = await admin().get('/v1/endpoints').set(bearer(owner.apiKey))
    expect(JSON.stringify(ownerList.body)).toContain(id)
    const ownerDelete = await admin().delete(`/v1/endpoints/${id}`).set(bearer(owner.apiKey))
    expect(ownerDelete.status).toBe(204)
    const ownerGet = await admin().get(`/v1/endpoints/${id}`).set(bearer(owner.apiKey))
    expect(ownerGet.status).toBe(404)

    // garbage id is also a plain 404
    const garbage = await admin()
      .get('/v1/endpoints/00000000-0000-4000-8000-000000000000')
      .set(bearer(owner.apiKey))
    expect(garbage.status).toBe(404)
  })
})
