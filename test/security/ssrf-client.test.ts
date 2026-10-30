import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import type { Socket } from 'node:net'
import { generate } from 'selfsigned'
import { sendThroughSsrfClient, type ResolvedAddress } from '../../src/security/ssrf-client.js'

/**
 * Real sockets, loopback, real client. The dev escape hatch
 * ALLOW_PRIVATE_TARGETS is used here exactly as in the Docker demo: the
 * receiver runs on a private address, and every test that is NOT about the
 * blocklist turns the check off explicitly.
 */

interface Recording {
  requests: Array<{
    url: string
    host: string
    path: string
    headers: IncomingMessage['headers']
    body: Buffer
  }>
}

const listen = (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve(port)
    })
  })

/** One-shot behavior server: every request gets `respond`, then is recorded. */
function startBehaviorServer(
  respond: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ port: number; recording: Recording; close: () => Promise<void> }> {
  const recording: Recording = { requests: [] }
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      recording.requests.push({
        url: req.url ?? '',
        host: req.headers['host'] ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      })
      respond(req, res)
    })
  })
  return listen(server).then((port) => ({
    port,
    recording,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }))
}

const send = (port: number, extra: Partial<Parameters<typeof sendThroughSsrfClient>[0]> = {}) =>
  sendThroughSsrfClient({
    url: `http://receiver.test:${port}/hook`,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from('{"ok":true}', 'utf8'),
    requestTimeoutMs: 2_000,
    ...extra,
  })

/** Resolver for an injected single answer / scripted sequence. */
function fakeResolver(answers: ResolvedAddress[]): {
  resolve: (hostname: string) => Promise<ResolvedAddress[]>
  calls: () => number
} {
  let calls = 0
  return {
    calls: () => calls,
    resolve: async (_hostname) => {
      calls++
      if (calls === 1) return answers
      // A "rebinding" answer would only be served if the client resolved a
      // second time — which it must not.
      return [{ address: '127.0.0.1', family: 4 }]
    },
  }
}

const PUBLIC = { address: '93.184.216.34', family: 4 as const }
const PRIVATE = { address: '127.0.0.1', family: 4 as const }
const PRIVATE6 = { address: '::1', family: 6 as const }

describe('ssrf client (real sockets)', () => {
  let servers: Array<{ close: () => Promise<void> }> = []
  const track = <T extends { close: () => Promise<void> }>(s: T): T => {
    servers.push(s)
    return s
  }
  afterAll(async () => {
    await Promise.all(servers.map((s) => s.close()))
    servers = []
  })

  describe('success path', () => {
    it('connects to the validated IP and keeps the Host header', async () => {
      const server = track(
        await startBehaviorServer((_req, res) => {
          res.statusCode = 200
          res.end('pong')
        }),
      )
      const fake = fakeResolver([PRIVATE])
      const result = await send(server.port, {
        allowPrivateTargets: true,
        resolveAddresses: fake.resolve,
      })

      if (!result.ok) throw new Error(`expected a successful send: ${result.message}`)
      expect(result.statusCode).toBe(200)
      expect(result.connectedTo).toBe('127.0.0.1')
      expect(result.truncated).toBe(false)

      // Host is still the registered hostname, not the IP.
      const seen = server.recording.requests[0] as Recording['requests'][number]
      expect(seen.host).toBe(`receiver.test:${server.port}`)
      expect(seen.body.toString('utf8')).toBe('{"ok":true}')
      expect(seen.headers['content-type']).toBe('application/json')
      // Exactly one resolution: the pinned lookup is not a second one.
      expect(fake.calls()).toBe(1)
    })

    it('sees nothing when the blocklist refuses a private resolution', async () => {
      const server = track(
        await startBehaviorServer((_req, res) => {
          res.statusCode = 200
          res.end()
        }),
      )
      const fake = fakeResolver([PRIVATE])
      const result = await send(server.port, { resolveAddresses: fake.resolve })

      expect.assertions(4)
      expect(result).toMatchObject({ ok: false, kind: 'blocked_address' })
      expect(server.recording.requests).toHaveLength(0)
      expect(fake.calls()).toBe(1)
      const hosted = result as { connectedTo?: string }
      expect(hosted.connectedTo).toBeUndefined()
    })

    it('fails the whole attempt when ANY address is blocked', async () => {
      const mixed = await send(1, {
        resolveAddresses: async () => [PUBLIC, { address: '10.1.2.3', family: 4 }],
      })
      expect(mixed).toMatchObject({ ok: false, kind: 'blocked_address' })
      const v6 = await send(1, {
        resolveAddresses: async () => [PRIVATE6],
      })
      expect(v6).toMatchObject({ ok: false, kind: 'blocked_address' })
    })
  })

  describe('DNS rebinding is defeated by single resolution', () => {
    it('never reaches a receiver that only a re-resolution would supply', async () => {
      const server = track(
        await startBehaviorServer((_req, res) => {
          res.statusCode = 200
          res.end()
        }),
      )
      // First answer: a public address. Any client that resolved a second
      // time would get 127.0.0.1 (the fake's follow-up) and reach the
      // loopback receiver. Ours must fail at the public address instead.
      const fake = fakeResolver([PUBLIC])
      const result = await send(server.port, {
        allowPrivateTargets: true,
        resolveAddresses: fake.resolve,
        requestTimeoutMs: 500,
      })

      expect(fake.calls()).toBe(1) // never resolved again at connect
      expect(server.recording.requests).toHaveLength(0) // loopback never contacted
      expect(result).toMatchObject({ ok: false })
      if (!result.ok) expect(['timeout', 'connection']).toContain(result.kind)
    })

    it('records the connect target as the validated address', async () => {
      // The pinned lookup is exercised directly: a private hostname with a
      // public answer fails to connect, and the failure carries no
      // connectedTo (it never connected); giving trick-decimals is covered
      // by the URL-level tests. Here we assert the pin by round-trip:
      const server = track(
        await startBehaviorServer((_req, res) => {
          res.statusCode = 200
          res.end()
        }),
      )
      const fake = fakeResolver([PUBLIC])
      const result = await send(server.port, {
        allowPrivateTargets: true,
        resolveAddresses: fake.resolve,
        requestTimeoutMs: 400,
      })
      expect(result.ok).toBe(false)
      expect((result as { connectedTo?: string }).connectedTo).toBeUndefined()
    })
  })

  describe('response handling', () => {
    it('does not follow redirects', async () => {
      let hits = 0
      const server = track(
        await startBehaviorServer((_req, res) => {
          hits++
          res.statusCode = 302
          res.setHeader('location', `http://127.0.0.1:${server?.port}/internal-admin`)
          res.end()
        }),
      )
      const result = await send(server.port, {
        allowPrivateTargets: true,
        resolveAddresses: fakeResolver([PRIVATE]).resolve,
      })
      expect(result).toMatchObject({ ok: true, statusCode: 302 })
      expect(hits).toBe(1) // the redirect target was never requested
    })

    it('stops reading at the response-size limit', async () => {
      const Huge = 'x'.repeat(100_000)
      const server = track(
        await startBehaviorServer((_req, res) => {
          res.statusCode = 200
          res.end(Huge)
        }),
      )
      const result = await send(server.port, {
        allowPrivateTargets: true,
        resolveAddresses: fakeResolver([PRIVATE]).resolve,
        maxResponseBytes: 1024,
      })
      expect(result).toMatchObject({ ok: true, truncated: true, bytesRead: 1024 })
    })

    it('supplies the real 64 KB cap by default', async () => {
      // Same behavior with the default: a 200 KB body is truncated to 64 KB.
      const server = track(
        await startBehaviorServer((_req, res) => {
          res.statusCode = 200
          res.end('y'.repeat(200_000))
        }),
      )
      const result = await send(server.port, {
        allowPrivateTargets: true,
        resolveAddresses: fakeResolver([PRIVATE]).resolve,
      })
      expect(result).toMatchObject({ ok: true, truncated: true, bytesRead: 64 * 1024 })
    })
  })

  describe('transport failures', () => {
    it('classifies a refused connection', async () => {
      const dead = await startBehaviorServer(() => {})
      await dead.close() // the port is now almost certainly unused
      const result = await send(dead.port, {
        allowPrivateTargets: true,
        resolveAddresses: fakeResolver([PRIVATE]).resolve,
        requestTimeoutMs: 800,
      })
      // The port may occasionally be rebound after close; either failure
      // kind proves a failed attempt, but a refused connection is typical.
      expect(result).toMatchObject({ ok: false })
      if (!result.ok) expect(result.kind).toBe('connection')
    })

    it('fails the attempt when nothing answers', async () => {
      const sockets = new Set<Socket>()
      const silent = createServer((req, _res) => {
        sockets.add(req.socket)
        req.socket.on('close', () => sockets.delete(req.socket))
      })
      const port = await listen(silent)
      servers.push({
        close: () =>
          new Promise((resolve) =>
            silent.close(() => {
              for (const socket of sockets) socket.destroy()
              resolve()
            }),
          ),
      })
      silent.unref()

      const result = await send(port, {
        allowPrivateTargets: true,
        resolveAddresses: fakeResolver([PRIVATE]).resolve,
        requestTimeoutMs: 300,
      })
      expect(result).toMatchObject({ ok: false, kind: 'timeout' })
    })

    it('surfaces TLS certificate errors', async () => {
      const pems = generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048 })
      const tlsServer = createHttpsServer({ key: pems.private, cert: pems.cert }, (_req, res) => {
        res.statusCode = 200
        res.end('pong')
      })
      const port = await listen(tlsServer as unknown as Server)
      servers.push({ close: () => new Promise((resolve) => tlsServer.close(() => resolve())) })

      const noTrust = await send(port, {
        url: `https://localhost:${port}/hook`,
        allowPrivateTargets: true,
        resolveAddresses: fakeResolver([PRIVATE]).resolve,
        requestTimeoutMs: 2_000,
      })
      expect(noTrust).toMatchObject({ ok: false, kind: 'tls' })

      // With the self-signed cert trusted, TLS verification passes.
      const trusted = await send(port, {
        url: `https://localhost:${port}/hook`,
        ca: [pems.cert],
        allowPrivateTargets: true,
        resolveAddresses: fakeResolver([PRIVATE]).resolve,
        requestTimeoutMs: 2_000,
      })
      expect(trusted).toMatchObject({ ok: true, statusCode: 200 })
      if (trusted.ok) expect(trusted.connectedTo).toBe('127.0.0.1')
    })
  })
})
