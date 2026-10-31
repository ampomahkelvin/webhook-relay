import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestDatabase, type TestDatabase } from '../helpers/test-db.js'
import { TEST_ENCRYPTION_KEY } from '../helpers/test-app.js'
import { createReceiverApp } from '../../examples/receiver/server.js'
import {
  createSigningSecret,
  decodeEncryptionKey,
  decryptSecret,
  encryptSecret,
} from '../../src/security/crypto.js'
import { buildOutboundRequest } from '../../src/domain/outbound-request.js'
import { sendThroughSsrfClient } from '../../src/security/ssrf-client.js'
import { classifyAttempt } from '../../src/domain/classify.js'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Phase 4 done-when (PLAN section 3): one hand-made delivery reaches the
 * sample receiver, and the receiver verifies the signature. The send is
 * composed from the production building blocks exactly as the Phase 5
 * sender will: decrypt the secret → build the request → SSRF client →
 * classify.
 */

interface ReceivedEntry {
  webhookId: string
  payload: { data?: { amount?: number }; type?: string }
  repeats: number
}

async function fetchReceived(port: number): Promise<ReceivedEntry[]> {
  const response = await fetch(`http://127.0.0.1:${port}/__received`)
  return (await response.json()) as ReceivedEntry[]
}

/** The endpoint's secret; the receiver must hold the same one to verify. */
const RECEIVER_SECRET = createSigningSecret()

describe('send-once through the SSRF client to the sample receiver', () => {
  let env: TestDatabase
  let server: Server
  let port: number
  let received: ReturnType<typeof createReceiverApp>['received']

  beforeAll(async () => {
    env = await startTestDatabase()
    const receiver = createReceiverApp({
      secret: RECEIVER_SECRET,
      toleranceSeconds: 300,
    })
    received = receiver.received
    // Dual-stack listener: `localhost` may resolve to ::1 or 127.0.0.1 on
    // any machine, and the SSRF client must reach the receiver through
    // whichever validated answer it pins.
    server = receiver.app.listen(0)
    server.unref()
    await new Promise<void>((resolve) => {
      server.on('listening', () => {
        port = (server.address() as AddressInfo).port
        resolve()
      })
    })
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await env.stop()
  })

  /** Insert a tenant + endpoint + event + delivery (the "hand-made" rows). */
  async function seedDelivery(): Promise<string> {
    const secret = RECEIVER_SECRET
    const key = decodeEncryptionKey(TEST_ENCRYPTION_KEY)
    const tenants = await env.pool.query<{ id: string }>(
      "INSERT INTO tenants (name) VALUES ('send-once') RETURNING id",
    )
    const tenantId = (tenants.rows[0] as { id: string }).id
    const endpoints = await env.pool.query<{ id: string }>(
      `INSERT INTO endpoints (tenant_id, url, event_types, secret_ciphertext)
       VALUES ($1, $2, ARRAY['*']::text[], $3) RETURNING id`,
      [tenantId, `http://localhost:${port}/hook`, encryptSecret(secret, key)],
    )
    const endpointId = (endpoints.rows[0] as { id: string }).id
    const events = await env.pool.query<{ id: string }>(
      `INSERT INTO events (tenant_id, event_type, payload, idempotency_key, request_hash)
       VALUES ($1, 'invoice.paid', $2::jsonb, 'seed-key', sha256('seed'::bytea)) RETURNING id`,
      [tenantId, JSON.stringify({ amount: 42, currency: 'USD' })],
    )
    const eventId = (events.rows[0] as { id: string }).id
    await env.pool.query('INSERT INTO deliveries (event_id, endpoint_id) VALUES ($1, $2)', [
      eventId,
      endpointId,
    ])
    return eventId
  }

  interface DeliveryRow {
    event_type: string
    payload: unknown
    created_at: Date
    secret_ciphertext: Buffer
    endpoint_url: string
  }

  /** The per-attempt composition the Phase 5 sender reuses. */
  async function sendSeededDelivery(eventId: string): Promise<void> {
    const row = (
      await env.pool.query<DeliveryRow>(
        `SELECT e.event_type, e.payload, e.created_at, ep.secret_ciphertext, ep.url AS endpoint_url
         FROM events e
         JOIN deliveries d ON d.event_id = e.id
         JOIN endpoints ep ON ep.id = d.endpoint_id
         WHERE e.id = $1`,
        [eventId],
      )
    ).rows[0] as DeliveryRow

    const secret = decryptSecret(row.secret_ciphertext, decodeEncryptionKey(TEST_ENCRYPTION_KEY))
    const request = buildOutboundRequest(
      {
        eventId,
        eventType: row.event_type,
        createdAtIso: row.created_at.toISOString(),
        payload: row.payload,
      },
      { url: row.endpoint_url, secret },
      { allowInsecureHttp: true }, // dev-only flag: the receiver runs on loopback
    )
    const result = await sendThroughSsrfClient({
      url: request.target.toString(),
      headers: request.headers,
      body: request.body,
      allowPrivateTargets: true, // the dev escape hatch the demo uses
      requestTimeoutMs: 2_000,
    })
    if (!result.ok) throw new Error(`send failed: ${result.message} (${result.kind})`)
    expect(classifyAttempt({ statusCode: result.statusCode })).toEqual({ kind: 'succeeded' })
  }

  it('delivers a signed webhook the receiver verifies', async () => {
    const eventId = await seedDelivery()
    await sendSeededDelivery(eventId)

    const log = await fetchReceived(port)
    expect(log).toHaveLength(1)
    const entry = log[0] as ReceivedEntry
    expect(entry.webhookId).toBe(eventId) // Webhook-Id is the event id
    expect(entry.payload.type).toBe('invoice.paid')
    expect(entry.payload.data).toEqual({ amount: 42, currency: 'USD' })
    expect(entry.repeats).toBe(0)
  })

  it('records the at-least-once duplicate on a re-send', async () => {
    const eventId = await seedDelivery()
    await sendSeededDelivery(eventId)
    await sendSeededDelivery(eventId) // e.g. a worker died after the receiver got it

    const log = await fetchReceived(port)
    const mine = log.find((entry) => entry.webhookId === eventId)
    expect(mine?.repeats).toBe(1) // deduped on Webhook-Id, not stored twice
  })

  it('rejects an unsigned POST the way a real receiver would', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"spoofed":true}',
    })
    expect(response.status).toBe(401)
    expect(received.size).toBeGreaterThanOrEqual(0)
  })
})
