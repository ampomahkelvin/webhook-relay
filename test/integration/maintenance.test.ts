import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Pool } from 'pg'
import {
  runMaintenanceSweep,
  MAINTENANCE_LOCK_ID,
  type SweepOptions,
} from '../../src/maintenance/sweep.js'
import {
  startTestApp,
  TEST_ADMIN_KEY,
  TEST_ENCRYPTION_KEY,
  type TestApp,
} from '../helpers/test-app.js'
import { seedWorkload, type SeedWorkload } from '../helpers/seed.js'
import { createApp } from '../../src/api/app.js'
import { Metrics } from '../../src/observability/metrics.js'
import { createLogger } from '../../src/logger.js'
import { createDispatcher, type DispatcherConfig } from '../../src/dispatcher/loop.js'
import { startModeServer, type ModeServer } from '../helpers/mode-server.js'

/**
 * Maintenance sweeps (DESIGN sections 3/7) against a real Postgres:
 * retention pruning with cascades, the expiry sweep, auto-disable, and the
 * advisory-lock exclusion. Observability (DESIGN section 11) is asserted
 * over HTTP: the lag gauge reports a deliberately delayed delivery and the
 * counters move on intake and dispatcher outcomes.
 */

const NEVER = 'http://localhost:9/never-served'

const sweepOptions = (overrides: Partial<SweepOptions> = {}): SweepOptions => ({
  retentionDays: 30,
  deliveryMaxAgeHours: 72,
  autoDisableAfterDays: 5,
  ...overrides,
})

async function logAttempt(pool: Pool, deliveryId: string, attempt: number): Promise<void> {
  await pool.query(
    `INSERT INTO delivery_attempts
       (delivery_id, attempt_number, started_at, duration_ms, status_code, response_snippet)
     VALUES ($1, $2, now(), 25, 500, 'kaboom')`,
    [deliveryId, attempt],
  )
}

describe('maintenance sweeps', () => {
  let env: TestApp
  beforeAll(async () => {
    env = await startTestApp()
  })
  afterAll(async () => {
    await env.stop()
  })
  const pool = (): Pool => env.db.pool

  it('retention prunes old events and cascades deliveries and attempt logs', async () => {
    // A recent workload that must survive, then an old one that must go.
    const fresh: SeedWorkload = await seedWorkload(pool(), { count: 1, endpointUrl: NEVER })
    const old: SeedWorkload = await seedWorkload(pool(), { count: 3, endpointUrl: NEVER })
    await pool().query(
      `UPDATE events SET created_at = now() - interval '40 days'
       WHERE id IN (SELECT event_id FROM deliveries WHERE endpoint_id = $1)`,
      [old.endpointId],
    )
    for (const deliveryId of old.deliveryIds) await logAttempt(pool(), deliveryId, 1)

    const result = await runMaintenanceSweep(pool(), sweepOptions())
    expect(result.swept).toBe(true)
    expect(result.eventsDeleted).toBe(3)

    // The old event's rows are gone — deliveries by ON DELETE CASCADE.
    const oldLeft = await pool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM deliveries WHERE endpoint_id = $1`,
      [old.endpointId],
    )
    expect(Number(oldLeft.rows[0]!.n)).toBe(0)
    const oldAttempts = await pool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM delivery_attempts a
       JOIN deliveries d ON d.id = a.delivery_id
       JOIN events e ON e.id = d.event_id
       WHERE e.tenant_id = $1`,
      [old.tenantId],
    )
    expect(Number(oldAttempts.rows[0]!.n)).toBe(0)

    // The fresh workload is untouched.
    const freshLeft = await pool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM deliveries WHERE endpoint_id = $1 AND status = 'pending'`,
      [fresh.endpointId],
    )
    expect(Number(freshLeft.rows[0]!.n)).toBe(1)
  })

  it('the expiry sweep kills stale pending deliveries (attempts survive), leaving fresh ones', async () => {
    const seed: SeedWorkload = await seedWorkload(pool(), { count: 3, endpointUrl: NEVER })
    const [stale] = seed.deliveryIds
    await logAttempt(pool(), stale!, 1)
    await pool().query(
      `UPDATE deliveries SET created_at = now() - interval '96 hours' WHERE id = $1`,
      [stale],
    )

    const result = await runMaintenanceSweep(pool(), sweepOptions({ deliveryMaxAgeHours: 72 }))
    expect(result.swept).toBe(true)
    expect(result.deliveriesExpired).toBe(1)

    const staleRow = await pool().query<{ status: string; completed_at: Date | null }>(
      `SELECT status::text, completed_at FROM deliveries WHERE id = $1`,
      [stale],
    )
    expect(staleRow.rows[0]).toMatchObject({ status: 'dead' })
    expect(staleRow.rows[0]!.completed_at).not.toBeNull()
    // The attempt log is append-only history: expiry adds none, removes none.
    const attempts = await pool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM delivery_attempts WHERE delivery_id = $1`,
      [stale],
    )
    expect(Number(attempts.rows[0]!.n)).toBe(1)

    // The fresh siblings are still pending and claimable.
    const pending = await pool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM deliveries WHERE endpoint_id = $1 AND status = 'pending'`,
      [seed.endpointId],
    )
    expect(Number(pending.rows[0]!.n)).toBe(2)
  })

  it('auto-disable fires on endpoints failing longer than the threshold', async () => {
    const failing = await seedWorkload(pool(), { count: 1, endpointUrl: NEVER })
    const failingFresh = await seedWorkload(pool(), { count: 1, endpointUrl: NEVER })
    const manual = await seedWorkload(pool(), {
      count: 1,
      endpointUrl: NEVER,
      endpointStatus: 'disabled',
    })
    await pool().query(
      `UPDATE endpoints SET failing_since = now() - interval '6 days' WHERE id = $1`,
      [failing.endpointId],
    )
    await pool().query(
      `UPDATE endpoints SET failing_since = now() - interval '1 day' WHERE id = $1`,
      [failingFresh.endpointId],
    )
    await pool().query(
      `UPDATE endpoints SET failing_since = now() - interval '6 days' WHERE id = $1`,
      [manual.endpointId],
    )

    const result = await runMaintenanceSweep(pool(), sweepOptions())
    expect(result.endpointsDisabled).toBe(1)

    const state = async (endpointId: string) => {
      const row = await pool().query<{ status: string; disabled_reason: string | null }>(
        `SELECT status::text, disabled_reason FROM endpoints WHERE id = $1`,
        [endpointId],
      )
      return row.rows[0]!
    }
    expect(await state(failing.endpointId)).toMatchObject({
      status: 'disabled',
      disabled_reason: 'failing',
    })
    // Fresh failure: nothing yet.
    expect((await state(failingFresh.endpointId)).status).toBe('enabled')
    // Manually disabled stays manual (and the sweep does not re-enable).
    expect(await state(manual.endpointId)).toMatchObject({
      status: 'disabled',
      disabled_reason: 'manual',
    })
  })

  it('a competing maintenance process holding the advisory lock skips the tick', async () => {
    const holder = await pool().connect()
    try {
      const grabbed = await holder.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [MAINTENANCE_LOCK_ID],
      )
      expect(grabbed.rows[0]!.locked).toBe(true)

      const skipped = await runMaintenanceSweep(pool(), sweepOptions())
      expect(skipped.swept).toBe(false)
      expect(skipped.eventsDeleted).toBe(0)
      expect(skipped.deliveriesExpired).toBe(0)
      expect(skipped.endpointsDisabled).toBe(0)
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [MAINTENANCE_LOCK_ID])
      holder.release()
    }
  })

  it('the lock releases between sweeps: the very next sweep runs', async () => {
    const result = await runMaintenanceSweep(pool(), sweepOptions())
    expect(result.swept).toBe(true)
  })
})

describe('observability endpoints', () => {
  let env: TestApp
  let mode: ModeServer
  let metrics: Metrics
  let app: ReturnType<typeof createApp>
  let aliceKey: string

  beforeAll(async () => {
    env = await startTestApp()
    mode = await startModeServer()
    mode.mode.behavior = 'ok'
    // A dedicated app with an explicit registry so counter assertions are
    // deterministic whatever other tests submit to the shared database.
    metrics = new Metrics()
    app = createApp({
      pool: env.db.pool,
      logger: createLogger('test', 'silent'),
      adminApiKey: TEST_ADMIN_KEY,
      maxEndpointsPerTenant: 10,
      allowInsecureHttp: true,
      allowPrivateTargets: false,
      encryptionKey: TEST_ENCRYPTION_KEY,
      intake: { ratePerMinute: 1_000_000, burst: 10_000 },
      metrics,
    })

    const created = await request(app)
      .post('/admin/tenants')
      .set({ Authorization: `Bearer ${TEST_ADMIN_KEY}` })
      .send({ name: 'observability' })
    aliceKey = created.body.apiKey.key as string

    const endpoint = await request(app)
      .post('/v1/endpoints')
      .set({ Authorization: `Bearer ${aliceKey}` })
      .send({ url: mode.url, eventTypes: ['*'] })
    if (endpoint.status !== 201) throw new Error(`endpoint create failed: ${endpoint.status}`)
  })
  afterAll(async () => {
    await mode.close()
    await env.stop()
  })

  const submit = async () =>
    request(app)
      .post('/v1/events')
      .set({ Authorization: `Bearer ${aliceKey}` })
      .set('Idempotency-Key', `obs-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
      .send({ eventType: 'demo.ping', payload: { n: 1 } })

  it('reports a deliberately delayed delivery on /health/deep and the lag gauge', async () => {
    // One delivery that has been due for ten minutes: the lag signal.
    await seedWorkload(env.db.pool, {
      count: 1,
      endpointUrl: NEVER,
      nextAttemptAt: new Date(Date.now() - 10 * 60_000),
    })

    const deep = await request(app).get('/health/deep')
    expect(deep.status).toBe(200)
    expect(deep.body.db).toBe('up')
    expect(deep.body.pendingDeliveries).toBeGreaterThanOrEqual(1)
    expect(deep.body.oldestDueDeliveryAgeSeconds).toBeGreaterThan(500)
    expect(deep.body.oldestDueDeliveryAgeSeconds).toBeLessThan(800)
    // This observability app deliberately allows insecure http receivers,
    // so the deep health reports that (and nothing else).
    expect(deep.body.warnings).toHaveLength(1)
    expect(deep.body.warnings.join(' ')).toContain('ALLOW_INSECURE_HTTP')

    const metricsText = await request(app).get('/metrics')
    expect(metricsText.type).toBe('text/plain')
    const line = metricsText.text
      .split('\n')
      .find((l) => l.startsWith('oldest_due_delivery_age_seconds '))!
    expect(Number(line.split(' ')[1])).toBeGreaterThan(500)
    expect(metricsText.text).toMatch(/deliveries_pending \d+/)
  })

  it('reports unsafe flags in /health/deep warnings', async () => {
    const unsafeApp = createApp({
      pool: env.db.pool,
      logger: createLogger('test', 'silent'),
      adminApiKey: TEST_ADMIN_KEY,
      maxEndpointsPerTenant: 10,
      allowInsecureHttp: true,
      allowPrivateTargets: true,
      encryptionKey: TEST_ENCRYPTION_KEY,
      intake: { ratePerMinute: 1_000_000, burst: 10_000 },
      metrics: new Metrics(),
    })
    const deep = await request(unsafeApp).get('/health/deep')
    expect(deep.status).toBe(200)
    expect(deep.body.warnings).toHaveLength(2)
    expect(deep.body.warnings.join(' | ')).toContain('ALLOW_INSECURE_HTTP')
    expect(deep.body.warnings.join(' | ')).toContain('ALLOW_PRIVATE_TARGETS')
  })

  it('counts intake on 202s and dispatcher outcomes on the exposition', async () => {
    const first = await submit()
    expect(first.status).toBe(202)
    const second = await submit()
    expect(second.status).toBe(202)

    // Intake counter: two 202 submissions.
    let text = await (await request(app).get('/metrics')).text
    expect(text).toContain('events_received_total 2')

    // Dispatcher runs the delivery; outcome counter + latency histogram move.
    const dispatcher = createDispatcher(
      env.db.pool,
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
      createLogger('test', 'silent'),
      metrics,
    )
    dispatcher.start()
    try {
      const deadline = Date.now() + 15_000
      for (;;) {
        text = await (await request(app).get('/metrics')).text
        if (/deliveries_total\{outcome="succeeded"\} 2/.test(text)) break
        if (Date.now() > deadline) throw new Error(`dispatcher did not drain: ${text}`)
        await new Promise((r) => setTimeout(r, 50))
      }
    } finally {
      await dispatcher.stop()
    }

    expect(text).toContain('deliveries_total{outcome="succeeded"} 2')
    // The histogram's count reconciles with the outcome counters.
    const outcomeValue = (outcome: string) => {
      const match = text.match(new RegExp(`deliveries_total\\{outcome="${outcome}"\\} (\\d+)`))
      return match ? Number(match[1]) : 0
    }
    const countLine = text.match(/delivery_attempt_duration_seconds_count\{\} (\d+)/)
    expect(countLine).not.toBeNull()
    const attemptsApplied = outcomeValue('succeeded') + outcomeValue('retry') + outcomeValue('dead')
    expect(Number(countLine![1])).toBe(attemptsApplied)
    expect(attemptsApplied).toBeGreaterThanOrEqual(2)
    // The endpoint was healthy: the breaker gauge is zero.
    expect(text).toContain('endpoints_circuit_open 0')
  })
})
