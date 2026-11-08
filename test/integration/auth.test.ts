import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { startTestApp, TEST_ADMIN_KEY, type TestApp } from '../helpers/test-app.js'

let env: TestApp
beforeAll(async () => {
  env = await startTestApp()
})
afterAll(() => env.stop())

const admin = () => request(env.app)
const bearer = (key: string) => ({ Authorization: `Bearer ${key}` })

describe('admin authentication', () => {
  it('rejects a missing admin key', async () => {
    const response = await admin().post('/admin/tenants').send({ name: 'acme' })
    expect(response.status).toBe(401)
    expect(response.body.code).toBe('UNAUTHORIZED')
  })

  it('rejects a wrong admin key', async () => {
    const response = await admin()
      .post('/admin/tenants')
      .set({ Authorization: `Bearer ${TEST_ADMIN_KEY.slice(0, -1)}x` })
      .send({ name: 'acme' })
    expect(response.status).toBe(401)
  })

  it('rejects a tenant key on the admin namespace', async () => {
    const created = await admin()
      .post('/admin/tenants')
      .set(bearer(TEST_ADMIN_KEY))
      .send({ name: 'tenant-key-co' })
    expect(created.status).toBe(201)

    const response = await admin()
      .get('/admin/tenants')
      .set(bearer(created.body.apiKey.key as string))
    expect(response.status).toBe(401)
  })
})

describe('tenant creation', () => {
  it('creates a tenant and returns its first API key once', async () => {
    const response = await admin()
      .post('/admin/tenants')
      .set(bearer(TEST_ADMIN_KEY))
      .send({ name: 'acme' })

    expect(response.status).toBe(201)
    expect(response.body.tenant.id).toBeDefined()
    expect(response.body.tenant.name).toBe('acme')
    expect(response.body.apiKey.key).toMatch(/^whk_[A-Za-z0-9_-]{40,}$/)
  })

  it('validates the tenant name', async () => {
    const tooShort = await admin()
      .post('/admin/tenants')
      .set(bearer(TEST_ADMIN_KEY))
      .send({ name: '' })
    expect(tooShort.status).toBe(400)
    expect(tooShort.body.code).toBe('VALIDATION_ERROR')

    const tooLong = await admin()
      .post('/admin/tenants')
      .set(bearer(TEST_ADMIN_KEY))
      .send({ name: 'x'.repeat(101) })
    expect(tooLong.status).toBe(400)
  })

  it('rejects duplicate key hashes at the database level', async () => {
    const tenantA = await admin()
      .post('/admin/tenants')
      .set(bearer(TEST_ADMIN_KEY))
      .send({ name: 'dup-hash-a' })
    const tenantB = await admin()
      .post('/admin/tenants')
      .set(bearer(TEST_ADMIN_KEY))
      .send({ name: 'dup-hash-b' })

    const hashA = await env.db.pool.query('SELECT key_hash FROM api_keys WHERE tenant_id = $1', [
      tenantA.body.tenant.id,
    ])
    await expect(
      env.db.pool.query(
        'INSERT INTO api_keys (tenant_id, key_hash, key_prefix) VALUES ($1, $2, $3)',
        [tenantB.body.tenant.id, hashA.rows[0]?.key_hash, 'whk_dup0'],
      ),
    ).rejects.toMatchObject({ code: '23505' })
  })
})

describe('tenant authentication', () => {
  it('resolves a valid key on /v1/me', async () => {
    const created = await admin()
      .post('/admin/tenants')
      .set(bearer(TEST_ADMIN_KEY))
      .send({ name: 'auth-co' })

    const me = await admin()
      .get('/v1/me')
      .set(bearer(created.body.apiKey.key as string))
    expect(me.status).toBe(200)
    expect(me.body.tenant.id).toBe(created.body.tenant.id)
    expect(me.body.tenant.name).toBe('auth-co')
  })

  it('rejects an unknown key', async () => {
    const response = await admin()
      .get('/v1/me')
      .set(bearer('whk_' + 'A'.repeat(43)))
    expect(response.status).toBe(401)
    expect(response.body.code).toBe('UNAUTHORIZED')
  })

  it('rejects a missing or malformed header', async () => {
    const none = await admin().get('/v1/me')
    expect(none.status).toBe(401)

    const basic = await admin().get('/v1/me').set({ Authorization: 'Basic abc' })
    expect(basic.status).toBe(401)

    const empty = await admin().get('/v1/me').set({ Authorization: 'Bearer' })
    expect(empty.status).toBe(401)
  })

  it('rejects a revoked key and keeps other keys working', async () => {
    const created = await admin()
      .post('/admin/tenants')
      .set(bearer(TEST_ADMIN_KEY))
      .send({ name: 'revoke-co' })
    const tenantId = created.body.tenant.id as string
    const key1 = created.body.apiKey as { id: string; key: string }

    const issued = await admin()
      .post(`/admin/tenants/${tenantId}/api-keys`)
      .set(bearer(TEST_ADMIN_KEY))
    expect(issued.status).toBe(201)
    const key2 = issued.body.apiKey as { id: string; key: string }

    // both keys work before revocation
    await expect(admin().get('/v1/me').set(bearer(key1.key))).resolves.toMatchObject({
      status: 200,
    })
    await expect(admin().get('/v1/me').set(bearer(key2.key))).resolves.toMatchObject({
      status: 200,
    })

    const revoked = await admin()
      .post(`/admin/tenants/${tenantId}/api-keys/${key2.id}/revoke`)
      .set(bearer(TEST_ADMIN_KEY))
    expect(revoked.status).toBe(204)

    const after = await admin().get('/v1/me').set(bearer(key2.key))
    expect(after.status).toBe(401)

    // the other key keeps working
    const still = await admin().get('/v1/me').set(bearer(key1.key))
    expect(still.status).toBe(200)

    // revocation is idempotent
    const again = await admin()
      .post(`/admin/tenants/${tenantId}/api-keys/${key2.id}/revoke`)
      .set(bearer(TEST_ADMIN_KEY))
    expect(again.status).toBe(204)

    // unknown key id → 404
    const missing = await admin()
      .post(`/admin/tenants/${tenantId}/api-keys/00000000-0000-4000-8000-000000000000/revoke`)
      .set(bearer(TEST_ADMIN_KEY))
    expect(missing.status).toBe(404)
  })

  it('names the failing path parameter on revoke', async () => {
    const tenant = await admin().post('/admin/tenants').set(bearer(TEST_ADMIN_KEY)).send({
      name: 'param-co',
    })
    const tenantId = tenant.body.tenant.id as string

    // A malformed key id is the key route's fault, not the tenant's.
    const badKeyFormat = await admin()
      .post(`/admin/tenants/${tenantId}/api-keys/not-a-uuid/revoke`)
      .set(bearer(TEST_ADMIN_KEY))
    expect(badKeyFormat.status).toBe(404)
    expect(badKeyFormat.body.message).toBe('API key not found')

    const badTenant = await admin()
      .post('/admin/tenants/not-a-uuid/api-keys/00000000-0000-4000-8000-000000000000/revoke')
      .set(bearer(TEST_ADMIN_KEY))
    expect(badTenant.status).toBe(404)
    expect(badTenant.body.message).toBe('Tenant not found')
  })

  it('lists keys with prefixes only, never the secret', async () => {
    const created = await admin()
      .post('/admin/tenants')
      .set(bearer(TEST_ADMIN_KEY))
      .send({ name: 'list-co' })
    const tenantId = created.body.tenant.id as string

    const listing = await admin()
      .get(`/admin/tenants/${tenantId}/api-keys`)
      .set(bearer(TEST_ADMIN_KEY))
    expect(listing.status).toBe(200)
    expect(listing.body.apiKeys).toHaveLength(1)
    const keyRow = listing.body.apiKeys[0] as { prefix: string; revokedAt: string | null }
    expect(keyRow.prefix).toMatch(/^whk_/)
    expect(keyRow.revokedAt).toBeNull()

    const raw = JSON.stringify(listing.body)
    expect(raw).not.toContain(created.body.apiKey.key as string)
  })

  it('reflects revocation in the key listing', async () => {
    const created = await admin()
      .post('/admin/tenants')
      .set(bearer(TEST_ADMIN_KEY))
      .send({ name: 'listed-revoke-co' })
    const tenantId = created.body.tenant.id as string
    const key = created.body.apiKey as { id: string; key: string }
    await admin()
      .post(`/admin/tenants/${tenantId}/api-keys/${key.id}/revoke`)
      .set(bearer(TEST_ADMIN_KEY))

    const listing = await admin()
      .get(`/admin/tenants/${tenantId}/api-keys`)
      .set(bearer(TEST_ADMIN_KEY))
    expect((listing.body.apiKeys[0] as { revokedAt: string | null }).revokedAt).not.toBeNull()
  })
})
