import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { sendThroughSsrfClient, type ResolvedAddress } from '../../src/infra/ssrf-client.js'

/**
 * I4: DNS and address-fallback behavior of the SSRF client, over real
 * sockets on loopback.
 *
 *  - A resolution that never returns is cut off by the attempt budget.
 *  - A connect-phase failure falls back to the NEXT validated address
 *    (typical case: an unreachable IPv6 answer ahead of a working IPv4).
 *  - The blocklist still fails the whole attempt when ANY answer is
 *    private, even when a later answer would work.
 */

const listen = (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve(port)
    })
  })

function startOkServer(): Promise<{
  port: number
  hits: () => number
  close: () => Promise<void>
}> {
  let hits = 0
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    hits++
    res.statusCode = 200
    res.end('pong')
  })
  return listen(server).then((port) => ({
    port,
    hits: () => hits,
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

const PRIVATE = { address: '127.0.0.1', family: 4 as const }

describe('ssrf client address fallback and resolution timeout (I4)', () => {
  const closers: Array<{ close: () => Promise<void> }> = []
  afterAll(async () => {
    await Promise.all(closers.map((s) => s.close()))
  })

  it('a resolution that never returns is cut off by the attempt budget', async () => {
    const startedAt = Date.now()
    const result = await send(1, {
      requestTimeoutMs: 600,
      resolveAddresses: () => new Promise<ResolvedAddress[]>(() => {}),
    })
    expect(result).toMatchObject({ ok: false, kind: 'timeout' })
    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })

  it('a resolution error slower than the budget is also cut off', async () => {
    const result = await send(1, {
      requestTimeoutMs: 500,
      resolveAddresses: () =>
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('slow lookup')), 5_000),
        ),
    })
    expect(result).toMatchObject({ ok: false, kind: 'timeout' })
  })

  it('falls back to the next validated address when the first refuses to connect', async () => {
    const server = await startOkServer()
    closers.push(server)
    // [refusing address, working address]: the first connection attempt
    // fails with ECONNREFUSED (loopback port 9 is reserved and refused),
    // the second is the live server.
    const result = await send(server.port, {
      allowPrivateTargets: true,
      resolveAddresses: async () => [{ address: '127.0.0.2', family: 4 }, PRIVATE],
    })
    if (!result.ok) throw new Error(`expected success: ${result.kind} ${result.message}`)
    expect(result.statusCode).toBe(200)
    expect(result.connectedTo).toBe('127.0.0.1')
    expect(server.hits()).toBe(1)
  })

  it('falls back when the first address HANGS on connect (unroutable style)', async () => {
    // 203.0.113.0/24 (TEST-NET-3) is unroutable: connects hang or fail
    // without touching anything real. The connect budget cuts it off and
    // the loopback server answers.
    const server = await startOkServer()
    closers.push(server)
    const result = await send(server.port, {
      allowPrivateTargets: true,
      resolveAddresses: async () => [{ address: '203.0.113.1', family: 4 }, PRIVATE],
      requestTimeoutMs: 2_500,
    })
    if (!result.ok) throw new Error(`expected success: ${result.kind} ${result.message}`)
    expect(result.connectedTo).toBe('127.0.0.1')
    expect(server.hits()).toBe(1)
  }, 10_000)

  it('never falls back past a private answer: the attempt fails entirely', async () => {
    const server = await startOkServer()
    closers.push(server)
    const result = await send(server.port, {
      // No allowPrivateTargets: [public, private] fails the attempt
      // before connecting, even though the second address would work.
      resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }, PRIVATE],
      requestTimeoutMs: 800,
    })
    expect(result).toMatchObject({ ok: false, kind: 'blocked_address' })
    expect(server.hits()).toBe(0)
  })

  it('does not fall back after the request reached the wire', async () => {
    // One server that accepts the connection, then drops it before
    // responding: the request WAS sent, so trying a second address would
    // risk double-delivery. The attempt must fail as-is.
    let dropped = 0
    const dropping = createServer((req, res) => {
      dropped++
      req.resume()
      res.destroy()
    })
    const port = await listen(dropping)
    closers.push({ close: () => new Promise((r) => dropping.close(() => r())) })

    const result = await send(port, {
      allowPrivateTargets: true,
      resolveAddresses: async () => [PRIVATE, PRIVATE],
      requestTimeoutMs: 1_500,
    })
    expect(result).toMatchObject({ ok: false })
    expect(dropped).toBe(1)
  })
})
