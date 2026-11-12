import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  createDispatcher,
  type Dispatcher,
  type DispatcherConfig,
} from '../../src/dispatcher/loop.js'
import { startTestDatabase, type TestDatabase } from '../helpers/test-db.js'
import { seedWorkload, type SeedWorkload } from '../helpers/seed.js'
import { TEST_ENCRYPTION_KEY } from '../helpers/test-app.js'
import { createLogger } from '../../src/logger.js'

/**
 * C1 regression: a receiver that answers `200 OK` with a body whose first
 * 1,024 bytes are not clean UTF-8 used to poison the attempt's INSERT
 * (`response_snippet` is a `text` column). The thrown record looked like a
 * worker error, so the dispatcher re-sent the delivery every poll interval
 * until the breaker opened — hammering a perfectly healthy receiver.
 *
 * Whatever the body, a `200` must be delivered exactly once, logged once,
 * and leave the breaker closed.
 */

const SILENT = createLogger('test', 'fatal')

interface RawBodyServer {
  url: string
  hits: () => number
  close: () => Promise<void>
}

/** A receiver that answers every POST with exactly the given bytes and 200. */
function startRawBodyServer(body: () => Buffer): Promise<RawBodyServer> {
  return new Promise((resolve) => {
    let hits = 0
    const server: Server = createServer((_req, res) => {
      hits++
      reqDrain(_req, () => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(body())
      })
    })
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo
      resolve({
        // `localhost` on purpose: layer 1 rejects literal private IPs.
        url: `http://localhost:${port}/hook`,
        hits: () => hits,
        close: () => new Promise((c) => server.close(() => c())),
      })
    })
  })
}

/** Consume the request body so the response can be written. */
function reqDrain(req: IncomingMessage, done: () => void): void {
  req.resume()
  req.on('end', done)
  req.on('error', done)
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  { timeoutMs = 20_000, stepMs = 25 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error('waitUntil: condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

describe('odd response bodies are delivered exactly once (C1)', () => {
  let db: TestDatabase

  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db.stop()
  })

  function makeDispatcher(): Dispatcher {
    const config: DispatcherConfig = {
      concurrency: 4,
      batchSize: 4,
      perEndpointClaimCap: 4,
      pollIntervalMs: 50,
      leaseSeconds: 60,
      breakerThreshold: 5,
      breakerCooldownSeconds: 60,
      encryptionKeyBase64: TEST_ENCRYPTION_KEY,
      requestTimeoutMs: 3_000,
      allowInsecureHttp: true,
      allowPrivateTargets: true,
    }
    return createDispatcher(db.pool, config, SILENT)
  }

  const cases: Array<[string, () => Buffer]> = [
    ['plain ascii', () => Buffer.from('{"received":true}')],
    [
      'multibyte body cut at byte 1024',
      () => Buffer.from('€'.repeat(400), 'utf8'), // 1200 bytes; 1024 = 341×3+1 → cut lands mid-character
    ],
    ['body with a NUL byte', () => Buffer.from([0x7b, 0x00, 0x7d, 0x0a])],
    ['gzip-magic bytes', () => Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0xff, 0xc3, 0x28])],
    ['empty body', () => Buffer.alloc(0)],
    [
      '64 KB body of non-UTF-8 bytes',
      () => {
        const chunk = Buffer.alloc(65_536)
        for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 37 + 200) % 256
        return chunk
      },
    ],
  ]

  for (const [name, makeBody] of cases) {
    it(`delivers once for: ${name}`, async () => {
      const server = await startRawBodyServer(makeBody)
      try {
        const workload: SeedWorkload = await seedWorkload(db.pool, {
          count: 1,
          endpointUrl: server.url,
        })
        const dispatcher = makeDispatcher()
        dispatcher.start()
        try {
          await waitUntil(async () => {
            const row = await db.pool
              .query<{ status: string }>(`SELECT status::text FROM deliveries WHERE id = $1`, [
                workload.deliveryIds[0],
              ])
              .then((r) => r.rows[0]?.status)
            return row === 'succeeded'
          })
          // Settled — give a poll interval's worth of time for any
          // wrongful re-send to show up, then assert there was none.
          await new Promise((resolve) => setTimeout(resolve, 300))

          expect(server.hits()).toBe(1)
          const delivery = await db.pool
            .query<{ attempt_count: number }>(
              `SELECT attempt_count FROM deliveries WHERE id = $1`,
              [workload.deliveryIds[0]],
            )
            .then((r) => r.rows[0]!)
          expect(delivery.attempt_count).toBe(1)
          const endpoint = await db.pool
            .query<{ circuit_state: string; consecutive_failures: number }>(
              `SELECT circuit_state::text, consecutive_failures FROM endpoints WHERE id = $1`,
              [workload.endpointId],
            )
            .then((r) => r.rows[0]!)
          expect(endpoint.circuit_state).toBe('closed')
          expect(endpoint.consecutive_failures).toBe(0)
        } finally {
          await dispatcher.stop()
        }
      } finally {
        await server.close()
      }
    })
  }

  it('stores the odd snippet as valid UTF-8 text', async () => {
    const server = await startRawBodyServer(() => Buffer.from([0x1f, 0x8b, 0x00, 0xc3, 0x28]))
    try {
      const workload = await seedWorkload(db.pool, { count: 1, endpointUrl: server.url })
      const dispatcher = makeDispatcher()
      dispatcher.start()
      try {
        await waitUntil(
          async () =>
            (await db.pool
              .query<{ status: string }>(`SELECT status::text FROM deliveries WHERE id = $1`, [
                workload.deliveryIds[0],
              ])
              .then((r) => r.rows[0]?.status)) === 'succeeded',
        )
        const attempt = await db.pool
          .query<{ response_snippet: string | null }>(
            `SELECT response_snippet FROM delivery_attempts WHERE delivery_id = $1`,
            [workload.deliveryIds[0]],
          )
          .then((r) => r.rows[0]!)
        // The bytes survived as text: replacement characters, no throw.
        expect(attempt.response_snippet).toContain('\uFFFD')
      } finally {
        await dispatcher.stop()
      }
    } finally {
      await server.close()
    }
  })
})
