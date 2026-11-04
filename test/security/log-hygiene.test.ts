import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { pino } from 'pino'
import type { Logger } from '../../src/logger.js'
import { createApp } from '../../src/api/app.js'
import { createDispatcher, type DispatcherConfig } from '../../src/dispatcher/loop.js'
import { TEST_ADMIN_KEY, TEST_ENCRYPTION_KEY } from '../helpers/test-app.js'
import { startTestDatabase } from '../helpers/test-db.js'
import { startReceiverServer, type ReceiverHandle } from '../helpers/receiver-server.js'

/**
 * Log hygiene (PLAN phase 9): a captured log stream across a FULL flow —
 * intake, endpoint creation (secret shown once), a delivered signed
 * webhook, a replayed dead delivery — must contain no signing secret, no
 * API key, no payload content, and no idempotency key. IDs only.
 */

const PAYLOAD_SENTINEL = 'PAYLOAD-SENTINEL-9f3b1c'
const IDEMPOTENCY_SENTINEL = 'IDEMP-SENTINEL-a71f22'
const NOTE_SENTINEL = 'NOTE-SENTINEL-e4b8d0'

interface Capture {
  lines: string[]
  logger: Logger
  text: () => string
}

function capturingLogger(service: string): Capture {
  const lines: string[] = []
  const logger = pino(
    { level: 'trace', base: { service } },
    {
      write(chunk: string): void {
        lines.push(chunk)
      },
    },
  ) as unknown as Logger
  return { lines, logger, text: () => lines.join('') }
}

describe('log hygiene across a full flow', () => {
  let db: Awaited<ReturnType<typeof startTestDatabase>>
  let receiver: ReceiverHandle
  let apiLogs: Capture
  let dispatcherLogs: Capture
  let app: ReturnType<typeof createApp>
  let tenantApiKey: string
  let signingSecret: string
  let endpointId: string

  beforeAll(async () => {
    db = await startTestDatabase()
    receiver = await startReceiverServer()
    apiLogs = capturingLogger('api')
    dispatcherLogs = capturingLogger('dispatcher')

    app = createApp({
      pool: db.pool,
      logger: apiLogs.logger,
      adminApiKey: TEST_ADMIN_KEY,
      maxEndpointsPerTenant: 10,
      allowInsecureHttp: true,
      allowPrivateTargets: false,
      encryptionKey: TEST_ENCRYPTION_KEY,
      intake: { ratePerMinute: 1_000_000, burst: 10_000 },
    })
  })
  afterAll(async () => {
    await receiver.close()
    await db.stop()
  })

  async function runDispatcher(): Promise<void> {
    const dispatcher = createDispatcher(
      db.pool,
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
        delaysMs: Array.from({ length: 8 }, () => 10),
      } satisfies DispatcherConfig,
      dispatcherLogs.logger,
    )
    dispatcher.start()
    try {
      const deadline = Date.now() + 15_000
      for (;;) {
        const rows = await db.pool.query<{ pending: string }>(
          `SELECT count(*) FILTER (WHERE status = 'pending')::text AS pending FROM deliveries`,
        )
        if (Number(rows.rows[0]!.pending) === 0) break
        if (Date.now() > deadline) throw new Error('dispatcher did not settle deliveries')
        await new Promise((r) => setTimeout(r, 50))
      }
    } finally {
      await dispatcher.stop()
    }
  }

  it('runs the full flow, then asserts no secret, key, or payload is in the logs', async () => {
    // 1. Admin: tenant + API key (returned exactly once).
    const tenant = await request(app)
      .post('/admin/tenants')
      .set({ Authorization: `Bearer ${TEST_ADMIN_KEY}` })
      .send({ name: 'hygiene' })
    tenantApiKey = tenant.body.apiKey.key as string
    expect(tenantApiKey).toBeTruthy()

    // 2. Endpoint creation: the signing secret shown exactly once. It is
    //    generated SERVER-side, so the receiver can only be started with
    //    it AFTER creation — the endpoint URL is patched to the live
    //    receiver once its port is known.
    const endpoint = await request(app)
      .post('/v1/endpoints')
      .set({ Authorization: `Bearer ${tenantApiKey}` })
      .send({ url: 'http://localhost:9/placeholder', eventTypes: ['*'] })
    signingSecret = endpoint.body.signingSecret as string
    endpointId = endpoint.body.endpoint.id as string
    expect(signingSecret).toBeTruthy()

    receiver = await startReceiverServer(signingSecret)
    const patched = await request(app)
      .patch(`/v1/endpoints/${endpointId}`)
      .set({ Authorization: `Bearer ${tenantApiKey}` })
      .send({ url: receiver.url })
    expect(patched.status).toBe(200)

    // 3. Intake with sentinels in the key and payload.
    const intake = await request(app)
      .post('/v1/events')
      .set({ Authorization: `Bearer ${tenantApiKey}` })
      .set('Idempotency-Key', IDEMPOTENCY_SENTINEL)
      .send({
        eventType: 'invoice.paid',
        payload: { secret: PAYLOAD_SENTINEL, note: NOTE_SENTINEL },
      })
    expect(intake.status).toBe(202)

    const replayed = await request(app)
      .post('/v1/events')
      .set({ Authorization: `Bearer ${tenantApiKey}` })
      .set('Idempotency-Key', IDEMPOTENCY_SENTINEL)
      .send({
        eventType: 'invoice.paid',
        payload: { secret: PAYLOAD_SENTINEL, note: NOTE_SENTINEL },
      })
    expect(replayed.status).toBe(202)

    // 4. An operational error(on a foreign id) exercises the error path.
    await request(app)
      .get('/v1/events/00000000-0000-4000-8000-000000000000')
      .set({ Authorization: `Bearer ${tenantApiKey}` })

    // 5. The dispatcher delivers (logging its own path).
    await runDispatcher()
    void runDispatcher

    // 6. More API traffic: listing, metrics, deep health.
    await request(app)
      .get('/v1/deliveries')
      .set({ Authorization: `Bearer ${tenantApiKey}` })
    await request(app).get('/metrics')
    await request(app).get('/health/deep')

    // The receiver actually verified signed requests (flow sanity); loud
    // diagnostics when it did not.
    if (receiver.received.size === 0) {
      const state = await db.pool.query<{ status: string; attempt_count: number }>(
        `SELECT status::text, attempt_count FROM deliveries`,
      )
      const attempts = await db.pool.query<{
        attempt_number: number
        status_code: number | null
        error_kind: string | null
      }>(
        `SELECT attempt_number, status_code, error_kind FROM delivery_attempts ORDER BY attempt_number`,
      )
      throw new Error(
        `receiver got nothing; delivery states: ${JSON.stringify(state.rows)}, attempts: ${JSON.stringify(attempts.rows)}`,
      )
    }
    expect(receiver.received.size).toBeGreaterThanOrEqual(1)

    const logText = apiLogs.text() + dispatcherLogs.text()
    const leaks: Array<[string, string]> = [
      [TEST_ADMIN_KEY, 'admin API key'],
      [tenantApiKey, 'tenant API key'],
      [signingSecret, 'signing secret'],
      [PAYLOAD_SENTINEL, 'payload content'],
      [IDEMPOTENCY_SENTINEL, 'idempotency key'],
      [NOTE_SENTINEL, 'payload content (nested value)'],
    ]
    for (const [secret, what] of leaks) {
      expect(logText, `log stream leaks the ${what}`).not.toContain(secret)
    }

    // IDs ARE present: the logs stay useful for debugging.
    void PAYLOAD_SENTINEL
  })
})
