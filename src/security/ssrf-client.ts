import { request as httpRequest, Agent as HttpAgent, type IncomingMessage } from 'node:http'
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https'
import { lookup as systemLookup } from 'node:dns'
import { type LookupFunction } from 'node:net'
import { promisify } from 'node:util'
import { isIP } from 'node:net'
import { isBlockedAddress } from './ip-blocklist.js'
import { normalizeUrlHostname } from './hostname.js'

/**
 * The SSRF-safe outbound client. It sends to URLs tenants registered, so
 * every rule here is load-bearing (DESIGN section 8, layer 2):
 *
 *  1. The hostname is resolved once per attempt, up front — no cached
 *     answers, no agent connection reuse (reused sockets would skip this).
 *     The resolution phase is capped (5 s) inside the whole-attempt budget,
 *     so a hung lookup cannot outlive it.
 *  2. If ANY resolved address is in a blocked range the attempt fails as
 *     `blocked_address` before connecting (the DNS answer may change).
 *  3. The connection is pinned to the validated IP with a custom `lookup`
 *     that ignores the hostname it is given, while Host, TLS SNI, and
 *     certificate verification keep using the hostname. The hostname is
 *     therefore never resolved again — that defeats DNS rebinding.
 *  4. Redirects are never followed (node does not follow them; 3xx is a
 *     failed attempt, classified in domain/classify).
 *  5. TLS certificates are verified by default; tests may supply a `ca`.
 *  6. At most `maxResponseBytes` (default 64 KB) of the body is read, then
 *     the socket is destroyed. Callers store at most 1 KB of it.
 *  7. A connect-phase failure (no byte reached the wire) falls back to the
 *     next validated address; every answer was already blocklist-checked,
 *     so the safety property is unchanged.
 */

export interface ResolvedAddress {
  address: string
  family: 4 | 6
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000
/** Ceiling for the DNS resolution phase, inside the whole-attempt budget. */
const RESOLVE_TIMEOUT_MS = 5_000
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024

export type ClientErrorKind = 'timeout' | 'connection' | 'dns' | 'tls' | 'blocked_address'

export type SendResult =
  | {
      ok: true
      statusCode: number
      headers: Record<string, string | string[] | number | undefined>
      snippet: Buffer
      bytesRead: number
      truncated: boolean
      /** The IP the socket actually connected to (must equal the validated answer). */
      connectedTo: string
    }
  | {
      ok: false
      kind: ClientErrorKind
      message: string
      connectedTo?: string
      /**
       * True when the attempt failed before any byte reached the chosen
       * address (connect-phase failure). The driver uses it to fall back
       * to the next validated address — every answer was already checked,
       * so the safety property is unchanged.
       */
      connectPhase?: boolean
    }

export interface SsrfSendOptions {
  url: string
  headers: Record<string, string>
  body: Buffer
  /** Whole-attempt budget, default 10 s. */
  requestTimeoutMs?: number
  /** Read cap, default 64 KB. */
  maxResponseBytes?: number
  /** Trust-anchor override, for tests against self-signed servers only. */
  ca?: string[]
  /** Dev escape hatch (DESIGN section 8): skips the IP blocklist check. */
  allowPrivateTargets?: boolean
  resolveAddresses?: (hostname: string) => Promise<ResolvedAddress[]>
}

const lookupAll = promisify(systemLookup)

async function defaultResolve(hostname: string): Promise<ResolvedAddress[]> {
  // `all: true` covers /etc/hosts entries too; verbatim keeps OS order.
  const answers = await lookupAll(hostname, { all: true, verbatim: true, family: 0 })
  return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }))
}

class AttemptTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AttemptTimeoutError'
  }
}

/** TLS-flavoured connection errors, matched on the code or the message. */
function looksLikeTlsFailure(code: string, message: string): boolean {
  return (
    code.includes('CERT') ||
    code.startsWith('ERR_TLS') ||
    code.startsWith('ERR_SSL') ||
    code === 'EPROTO' ||
    /certificate|handshake/i.test(message)
  )
}

function failureKind(error: NodeJS.ErrnoException): ClientErrorKind {
  const code = error.code ?? ''
  if (error instanceof AttemptTimeoutError) return 'timeout'
  if (['ENOTFOUND', 'EAI_AGAIN', 'ESERVFAIL'].includes(code)) return 'dns'
  if (looksLikeTlsFailure(code, error.message ?? '')) return 'tls'
  return 'connection'
}

/** Reject a promise when `promise` has not settled within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AttemptTimeoutError(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export async function sendThroughSsrfClient(options: SsrfSendOptions): Promise<SendResult> {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES

  // A URL that fails here is an endpoint-configuration problem, not an
  // attempt: throw, and the caller turns it into a failed send.
  const targetUrl = new URL(options.url)
  const isTls = targetUrl.protocol === 'https:'
  if (!isTls && targetUrl.protocol !== 'http:') {
    throw new Error(`unsupported URL protocol '${targetUrl.protocol}'`)
  }

  const rawHostname = targetUrl.hostname
  const hostname = normalizeUrlHostname(rawHostname)
  const port = targetUrl.port === '' ? (isTls ? 443 : 80) : Number(targetUrl.port)
  const path = `${targetUrl.pathname}${targetUrl.search}` || '/'

  // The whole-attempt budget covers resolution TOO (it used to start only
  // at the request, so a hung lookup could outlive the 10 s — I4).
  const attemptStartedAt = Date.now()
  const remainingMs = (): number => Math.max(1, requestTimeoutMs - (Date.now() - attemptStartedAt))

  // --- Resolve ONCE, before any socket exists. ---
  const literalFamily = isIP(hostname)
  let answers: ResolvedAddress[]
  if (literalFamily !== 0) {
    answers = [{ address: hostname, family: literalFamily === 6 ? 6 : 4 }]
  } else {
    try {
      const resolver = options.resolveAddresses ?? defaultResolve
      answers = await withTimeout(
        resolver(hostname),
        Math.min(RESOLVE_TIMEOUT_MS, requestTimeoutMs),
        `DNS resolution for '${hostname}' exceeded its budget`,
      )
    } catch (error) {
      if (error instanceof AttemptTimeoutError) {
        return { ok: false, kind: 'timeout', message: error.message }
      }
      return {
        ok: false,
        kind: 'dns',
        message: `DNS resolution failed for '${hostname}': ${(error as Error).message}`,
      }
    }
  }
  if (answers.length === 0) {
    return { ok: false, kind: 'dns', message: `DNS resolution returned no addresses` }
  }

  // --- Any address in a blocked range fails the attempt entirely. ---
  if (options.allowPrivateTargets !== true) {
    for (const answer of answers) {
      if (isBlockedAddress(answer.address)) {
        return {
          ok: false,
          kind: 'blocked_address',
          message: `resolved address ${answer.address} is in a blocked range`,
        }
      }
    }
  }

  // --- Try the validated addresses in order until one connects. ---
  let last: SendResult | undefined
  for (let index = 0; index < answers.length; index++) {
    const chosen = answers[index] as ResolvedAddress
    const triesLeft = answers.length - index
    const budget = remainingMs()
    last = await connectAndSend({
      chosen,
      hostname,
      port,
      path,
      isTls,
      budgetMs: budget,
      // One hanging address must not consume the whole attempt: the
      // remaining budget is shared across the remaining tries.
      connectTimeoutMs: Math.min(
        DEFAULT_CONNECT_TIMEOUT_MS,
        Math.max(1, Math.floor(budget / triesLeft)),
      ),
      options,
      maxResponseBytes,
    })
    // A connect-phase failure means no byte reached the wire: the next
    // validated address (checked by the same blocklist pass above) is a
    // safe fallback — typically an unreachable IPv6 answer ahead of a
    // working IPv4 one on a host without IPv6 routing (those hang rather
    // than refuse, so the connect timer's timeout qualifies too). The
    // remaining budget is divided across the remaining tries, so one
    // hanging address cannot consume the whole attempt.
    if (last.ok || last.connectPhase !== true) return last
  }
  return last as SendResult
}

interface ConnectAndSendArgs {
  chosen: ResolvedAddress
  hostname: string
  port: number
  path: string
  isTls: boolean
  /** Whole-attempt budget REMAINING for this connection. */
  budgetMs: number
  connectTimeoutMs: number
  options: SsrfSendOptions
  maxResponseBytes: number
}

/** One pinned connection to one validated address. Never falls back. */
async function connectAndSend(args: ConnectAndSendArgs): Promise<SendResult> {
  const { chosen, hostname, port, path, isTls, budgetMs, connectTimeoutMs, options } = args

  return await new Promise<SendResult>((resolve) => {
    // Per-request agent with keepAlive off: the next attempt must resolve
    // and re-pin its own connection, not reuse one whose layer-2 checks
    // happened earlier.
    const agent = isTls
      ? new HttpsAgent({ keepAlive: false, maxSockets: 1 })
      : new HttpAgent({ keepAlive: false, maxSockets: 1 })

    let settled = false
    let gotHeaders = false
    let connected = false
    let connectTimedOut = false
    let connectedTo: string | undefined
    const chunks: Buffer[] = []
    let bytesRead = 0
    let truncated = false

    const timers: NodeJS.Timeout[] = []
    const cancelTimers = () => {
      for (const t of timers) clearTimeout(t)
    }
    const cleanup = () => {
      cancelTimers()
      agent.destroy()
    }
    const fail = (kind: ClientErrorKind, message: string) => {
      if (settled) return true
      settled = true
      cleanup()
      resolve({
        ok: false,
        kind,
        message,
        connectedTo,
        // Connect-phase = no byte reached the wire AND the failure is of
        // the connect itself (a refused/reset connection, or the connect
        // timer firing) — the driver may then try the next validated
        // address. A whole-attempt budget timeout is NOT one: retrying
        // would only burn the remaining budget.
        connectPhase: !connected && !gotHeaders && (kind === 'connection' || connectTimedOut),
      })
      return false
    }
    const succeed = (statusCode: number, headers: IncomingMessage['headers']) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        ok: true,
        statusCode,
        headers,
        snippet: Buffer.concat(chunks),
        bytesRead,
        truncated,
        connectedTo: connectedTo ?? chosen.address,
      })
    }

    const connectTimeoutError = new AttemptTimeoutError('connecting exceeded its time budget')
    const attemptTimeoutError = new AttemptTimeoutError('attempt exceeded its time budget')
    let attemptTimedOut = false

    // The pin: whatever hostname node asks for, this lookup returns the
    // validated address — so no second DNS resolution can happen.
    const pinnedLookup: LookupFunction = (_host, _opts, callback) => {
      callback(null, chosen.address, chosen.family)
    }

    const req = isTls
      ? httpsRequest({
          host: hostname,
          port,
          path,
          method: 'POST',
          headers: options.headers,
          agent,
          lookup: pinnedLookup,
          family: chosen.family,
          servername: hostname,
          ca: options.ca,
          rejectUnauthorized: true,
        })
      : httpRequest({
          host: hostname,
          port,
          path,
          method: 'POST',
          headers: options.headers,
          agent,
          lookup: pinnedLookup,
          family: chosen.family,
        })

    req.on('socket', (socket) => {
      timers.push(
        setTimeout(() => {
          connectTimedOut = true
          req.destroy(connectTimeoutError)
        }, connectTimeoutMs),
      )
      socket.once('connect', () => {
        connected = true
        connectedTo = socket.remoteAddress ?? chosen.address
      })
    })
    timers.push(
      setTimeout(() => {
        attemptTimedOut = true
        req.destroy(attemptTimeoutError)
      }, budgetMs),
    )

    req.on('error', (error: NodeJS.ErrnoException) => {
      fail(failureKind(error), error.message)
    })

    req.on('response', (res) => {
      gotHeaders = true
      succeedLater(res)
    })

    const succeedLater = (res: IncomingMessage) => {
      const statusCode = res.statusCode ?? 0
      let truncationStopped = false

      res.on('data', (chunk: Buffer) => {
        const remaining = args.maxResponseBytes - bytesRead
        if (remaining <= 0) {
          if (!truncationStopped) {
            truncationStopped = true
            truncated = true
            res.destroy()
          }
          return
        }
        if (chunk.length <= remaining) {
          chunks.push(chunk)
          bytesRead += chunk.length
          return
        }
        chunks.push(chunk.subarray(0, remaining))
        bytesRead = args.maxResponseBytes
        truncated = true
        truncationStopped = true
        res.destroy()
      })

      res.on('error', () => {
        // Our own destroy at the read cap is not an error of the attempt;
        // a budget timeout that fires during the body is a TIMEOUT, not a
        // connection drop (it is what destroyed the socket).
        if (truncationStopped) return
        if (attemptTimedOut) {
          fail('timeout', attemptTimeoutError.message)
          return
        }
        fail('connection', 'connection dropped during the response')
      })

      res.on('end', () => {
        succeed(statusCode, res.headers)
      })

      res.on('close', () => {
        if (settled) return
        if (truncationStopped) {
          succeed(statusCode, res.headers)
          return
        }
        if (attemptTimedOut) {
          fail('timeout', attemptTimeoutError.message)
          return
        }
        fail('connection', 'connection closed before the response finished')
      })
    }

    // Safety net: if the process-level socket closes without delivering a
    // response, never leave the promise unsettled.
    req.on('close', () => {
      if (!settled && !gotHeaders) fail('connection', 'socket closed before a response arrived')
    })

    req.end(options.body)
  })
}
