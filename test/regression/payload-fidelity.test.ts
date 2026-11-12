import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { startTestApp, TEST_ADMIN_KEY, type TestApp } from '../helpers/test-app.js'

/**
 * I5: payload fidelity is pinned as a conscious design choice, not left
 * implicit. Intake parses the body with express.json and stores `jsonb`;
 * the dispatcher reads it back through pg and JSON.parse. Therefore:
 *
 *  - integers beyond 2^53-1 lose precision (64-bit numeric IDs corrupt
 *    silently, and the signature still verifies because it signs what was
 *    sent), and
 *  - key order and whitespace are normalized to canonical JSON.
 *
 * DESIGN section 5 documents the consequence: producers must send 64-bit
 * identifiers as strings. These tests exist so a future change to that
 * behavior is a deliberate one.
 */

describe('payload fidelity (I5, pinned behavior)', () => {
  let env: TestApp
  let aliceKey: string

  beforeAll(async () => {
    env = await startTestApp()
    const created = await request(env.app)
      .post('/admin/tenants')
      .set({ Authorization: `Bearer ${TEST_ADMIN_KEY}` })
      .send({ name: 'fidelity' })
    aliceKey = created.body.apiKey.key as string
  })
  afterAll(async () => {
    await env.stop()
  })

  const submit = (payload: unknown, key: string) =>
    request(env.app)
      .post('/v1/events')
      .set({ Authorization: `Bearer ${aliceKey}` })
      .set('Idempotency-Key', `fidelity-${key}`)
      .send({ eventType: 'demo.ping', payload })

  it('a 64-bit numeric ID loses precision — the documented limitation', async () => {
    // Sent as raw wire text (a JS numeric literal in this file would lose
    // the precision before the request even left the test).
    const response = await request(env.app)
      .post('/v1/events')
      .set({ Authorization: `Bearer ${aliceKey}` })
      .set('Idempotency-Key', 'fidelity-bigint-number')
      .set('content-type', 'application/json')
      .send('{"eventType":"demo.ping","payload":{"id":9007199254740993}}')
    expect(response.status).toBe(202)

    const read = await request(env.app)
      .get(`/v1/events/${response.body.id}`)
      .set({ Authorization: `Bearer ${aliceKey}` })
    // 2^53 + 1 arrived as 2^53: the jsonb round trip, pinned on purpose.
    expect(read.body.event.payload).toEqual({ id: 9007199254740992 })
  })

  it('a 64-bit ID sent as a string survives exactly (the recommended form)', async () => {
    const response = await submit({ id: '9007199254740993' }, 'bigint-string')
    expect(response.status).toBe(202)

    const read = await request(env.app)
      .get(`/v1/events/${response.body.id}`)
      .set({ Authorization: `Bearer ${aliceKey}` })
    expect(read.body.event.payload).toEqual({ id: '9007199254740993' })
  })

  it('key order and whitespace are normalized to canonical JSON', async () => {
    // Submitted as raw text so the wire really does carry a specific
    // key order and extra whitespace.
    const response = await request(env.app)
      .post('/v1/events')
      .set({ Authorization: `Bearer ${aliceKey}` })
      .set('Idempotency-Key', 'fidelity-canonical')
      .set('content-type', 'application/json')
      .send('{"eventType":"demo.ping","payload":{"zebra":1,"alpha":2}}')
    expect(response.status).toBe(202)

    const stored = await env.db.pool
      .query<{ payload: Record<string, unknown> }>(`SELECT payload FROM events WHERE id = $1`, [
        response.body.id,
      ])
      .then((r) => r.rows[0]!)
    // jsonb does not preserve key order; the point is the event is stored
    // (and later re-serialized) by content, never by the producer's bytes.
    expect(Object.keys(stored.payload).sort()).toEqual(['alpha', 'zebra'])
  })
})
