import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createReceiverApp, type ReceivedWebhook } from '../../examples/receiver/server.js'
import { createSigningSecret } from '../../src/infra/secret-box.js'

export interface ReceiverHandle {
  port: number
  /** The `/hook` URL of the sample receiver's verified handler. */
  url: string
  secret: string
  received: Map<string, ReceivedWebhook>
  close: () => Promise<void>
}

/**
 * Start the sample receiver on an ephemeral loopback-reachable port for a
 * test. It listens on all interfaces so the SSRF client's pinned address
 * (`localhost` resolves to ::1 or 127.0.0.1) always connects.
 */
export async function startReceiverServer(secret = createSigningSecret()): Promise<ReceiverHandle> {
  const receiver = createReceiverApp({ secret, toleranceSeconds: 300 })
  const server: Server = receiver.app.listen(0)
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  const { port } = server.address() as AddressInfo
  return {
    port,
    // `localhost` on purpose: layer 1 (url validation) rejects literal
    // private IPs even before the SSRF client runs; the hostname rides on
    // the ssrf client's `allowPrivateTargets` escape (layer 2, post-DNS).
    url: `http://localhost:${port}/hook`,
    secret,
    received: receiver.received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
