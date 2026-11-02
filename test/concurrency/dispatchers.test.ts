import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createDispatcher, type DispatcherConfig } from '../../src/dispatcher/loop.js'
import { startTestDatabase, type TestDatabase } from '../helpers/test-db.js'
import { seedWorkload } from '../helpers/seed.js'
import { startReceiverServer, type ReceiverHandle } from '../helpers/receiver-server.js'
import { TEST_ADMIN_KEY, TEST_ENCRYPTION_KEY } from '../helpers/test-app.js'
import { createLogger } from '../../src/logger.js'

/**
 * Concurrency (DESIGN section 6.1/6.4): two dispatchers working the same
 * backlog claim disjoint sets, and a worker killed mid-send loses its lease
 * so the delivery is automatically retried — no send is ever lost, and no
 * send is ever done twice.
 */

const SILENT = createLogger('test', 'fatal')

async function waitUntil(
  predicate: () => Promise<boolean>,
  { timeoutMs = 60_000, stepMs = 50 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error('waitUntil: condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

async function countsByStatus(
  db: TestDatabase,
  endpointId: string,
): Promise<Record<string, number>> {
  const result = await db.pool.query<{ status: string; n: string }>(
    `SELECT status::text, count(*)::text AS n FROM deliveries WHERE endpoint_id = $1 GROUP BY status`,
    [endpointId],
  )
  return Object.fromEntries(result.rows.map((row) => [row.status, Number(row.n)]))
}

describe('two concurrent dispatchers', () => {
  let db: TestDatabase
  let receiver: ReceiverHandle

  const config = (): DispatcherConfig => ({
    concurrency: 25,
    batchSize: 20,
    perEndpointClaimCap: 10,
    pollIntervalMs: 20,
    leaseSeconds: 30,
    breakerThreshold: 5,
    breakerCooldownSeconds: 60,
    encryptionKeyBase64: TEST_ENCRYPTION_KEY,
    requestTimeoutMs: 8_000,
    allowInsecureHttp: true,
    allowPrivateTargets: true,
  })

  beforeAll(async () => {
    db = await startTestDatabase()
    receiver = await startReceiverServer()
  })
  afterAll(async () => {
    await receiver.close()
    await db.stop()
  })

  it('drain 400 deliveries together: every delivery succeeds exactly once', async () => {
    const seed = await seedWorkload(db.pool, {
      count: 400,
      endpointUrl: receiver.url,
      secret: receiver.secret,
    })
    const a = createDispatcher(db.pool, config(), SILENT)
    const b = createDispatcher(db.pool, config(), SILENT)
    a.start()
    b.start()
    try {
      await waitUntil(async () => (await countsByStatus(db, seed.endpointId)).succeeded === 400, {
        timeoutMs: 60_000,
      })

      const counts = await countsByStatus(db, seed.endpointId)
      expect(counts.succeeded).toBe(400)

      // 400 attempts, no more: nobody claimed a delivery twice.
      const attempts = await db.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM delivery_attempts da
         JOIN deliveries d ON d.id = da.delivery_id WHERE d.endpoint_id = $1`,
        [seed.endpointId],
      )
      expect(Number(attempts.rows[0]!.n)).toBe(400)
      const relitigated = await db.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM deliveries WHERE endpoint_id = $1 AND attempt_count > 1`,
        [seed.endpointId],
      )
      expect(Number(relitigated.rows[0]!.n)).toBe(0)

      // 400 unique webhooks arrived; the receiver never saw a repeat.
      expect(receiver.received.size).toBe(400)
      for (const webhook of receiver.received.values()) expect(webhook.repeats).toBe(0)
      expect(a.stats().stale).toBe(0)
      expect(b.stats().stale).toBe(0)
    } finally {
      await Promise.all([a.stop(), b.stop()])
    }
  })
})

interface HangServerHandle {
  /** Base URL of the hanging route. */
  url: string
  /** How many webhook ids have had their (possibly hung) first send. */
  firstSendsStarted(): number
  close(): Promise<void>
}

/**
 * A receiver whose FIRST send per webhook-id hangs for 6 s before
 * returning 200 (a slow request: connection accepted, no bytes back).
 * Later sends for the same id answer immediately.
 */
function startHangServer(): Promise<HangServerHandle> {
  return new Promise<HangServerHandle>((resolve) => {
    const seen = new Map<string, number>()
    const server: Server = createServer((req, res) => {
      const id = (req.headers['webhook-id'] as string | undefined) ?? 'unknown'
      const n = seen.get(id) ?? 0
      seen.set(id, n + 1)
      req.resume()
      if (n === 0) {
        setTimeout(() => {
          res.statusCode = 200
          res.end('{"slow":true}')
        }, 6_000)
      } else {
        res.statusCode = 200
        res.end('{"fast":true}')
      }
    })
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo
      resolve({
        // `localhost` on purpose: layer 1 (URL validation) rejects literal
        // private IPs; the hostname rides on the SSRF client's
        // `allowPrivateTargets` escape (layer 2, post-DNS).
        url: `http://localhost:${port}/hook`,
        firstSendsStarted: () => seen.size,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      })
    })
  })
}

describe('a dispatcher killed mid-send', () => {
  let db: TestDatabase

  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db.stop()
  })

  it('loses its lease so another dispatcher sends the delivery — nothing lost, nothing doubled', async () => {
    const hang = await startHangServer()
    try {
      const seed = await seedWorkload(db.pool, {
        count: 1,
        endpointUrl: hang.url,
      })
      const deliveryId = seed.deliveryIds[0]!

      // The child dispatcher claims the delivery and starts the hung send.
      const child: ChildProcess = spawn('npx', ['tsx', 'src/dispatcher/index.ts'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: db.container.getConnectionUri(),
          ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
          ADMIN_API_KEY: TEST_ADMIN_KEY,
          LOG_LEVEL: 'fatal',
          POLL_INTERVAL_MS: '100',
          LEASE_SECONDS: '3', // short: the orphaned lease frees quickly
          REQUEST_TIMEOUT_MS: '20000',
          ALLOW_INSECURE_HTTP: 'true',
          ALLOW_PRIVATE_TARGETS: 'true',
        },
        stdio: 'ignore',
      })

      // The child claimed exactly once: attempt 1, lease held.
      await waitUntil(
        async () =>
          (await db.pool
            .query<{ n: string }>(
              `SELECT count(*)::text AS n FROM deliveries WHERE id = $1 AND attempt_count = 1
                   AND locked_until IS NOT NULL`,
              [deliveryId],
            )
            .then((r) => Number(r.rows[0]!.n))) === 1,
        { timeoutMs: 20_000 },
      )
      expect(child.pid).toBeDefined()

      // Kill it while the send hangs: nothing is ever recorded for the
      // orphaned attempt.
      child.kill('SIGKILL')
      const exited = new Promise<null>((resolve) => child.once('exit', () => resolve(null)))
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))])

      // A fresh dispatcher picks it up once the orphaned lease expires and
      // the receiver's second send answers immediately.
      const successor = createDispatcher(
        db.pool,
        {
          concurrency: 4,
          batchSize: 2,
          perEndpointClaimCap: 2,
          pollIntervalMs: 100,
          leaseSeconds: 30,
          breakerThreshold: 5,
          breakerCooldownSeconds: 60,
          encryptionKeyBase64: TEST_ENCRYPTION_KEY,
          requestTimeoutMs: 8_000,
          allowInsecureHttp: true,
          allowPrivateTargets: true,
        },
        SILENT,
      )
      successor.start()
      try {
        await waitUntil(
          async () =>
            (await db.pool
              .query<{ status: string }>(`SELECT status::text FROM deliveries WHERE id = $1`, [
                deliveryId,
              ])
              .then((r) => r.rows[0]!.status)) === 'succeeded',
          { timeoutMs: 20_000 },
        )
      } finally {
        await successor.stop()
      }

      const row = await db.pool.query<{ attempt_count: number; status: string }>(
        `SELECT attempt_count, status::text FROM deliveries WHERE id = $1`,
        [deliveryId],
      )
      expect(row.rows[0]!.attempt_count).toBe(2)
      const loggedAttempts = await db.pool.query<{ a: number }>(
        `SELECT attempt_number::int AS a FROM delivery_attempts WHERE delivery_id = $1 ORDER BY attempt_number`,
        [deliveryId],
      )
      // The killed attempt is gone silently (no record), attempt 2 is the
      // one that stuck.
      expect(loggedAttempts.rows.map((r) => r.a)).toEqual([2])
      // The second send was the fast one: the first hung and died with -9.
      expect(hang.firstSendsStarted()).toBe(1)
    } finally {
      await hang.close()
    }
  })
})
