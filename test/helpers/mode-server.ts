import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A receiver the test steers in real time: flip `handle.mode` between
 * requests to script a probe failing once and succeeding the next, a
 * tarpit that starves a dispatcher's slots, or a 410 goodbye — each
 * deterministic, no fail-rate dice.
 */
export type ModeBehavior = 'ok' | 'fail' | 'tarpit' | 'gone'

export interface ModeServer {
  url: string
  mode: { behavior: ModeBehavior; tarpitMs: number }
  /** Total requests answered so far (any mode). */
  requestCount: () => number
  close: () => Promise<void>
}

export async function startModeServer(): Promise<ModeServer> {
  const state = { requests: 0, mode: { behavior: 'ok' as ModeBehavior, tarpitMs: 2_000 } }
  const server: Server = createServer((req, res) => {
    state.requests++
    req.resume()
    const { behavior, tarpitMs } = state.mode
    if (behavior === 'gone') {
      res.statusCode = 410
      res.end('{"gone":true}')
      return
    }
    if (behavior === 'tarpit') {
      setTimeout(() => {
        res.statusCode = 200
        res.end('{"slow":true}')
      }, tarpitMs)
      return
    }
    if (behavior === 'fail') {
      res.statusCode = 500
      res.end('{"injectedFailure":true}')
      return
    }
    res.statusCode = 200
    res.end('{"received":true}')
  })
  await new Promise<Server>((resolve, reject) => {
    server.once('listening', () => resolve(server))
    server.once('error', reject)
    server.listen(0)
  })
  const { port } = server.address() as AddressInfo
  return {
    // `localhost` on purpose: literal private IPs fail layer-1 URL
    // validation; the name rides on the SSRF client's private-target escape.
    url: `http://localhost:${port}/hook`,
    mode: state.mode,
    requestCount: () => state.requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
