import express, { type Request, type Response, type Express } from 'express'
import { verifyWebhook } from '../../src/domain/verification.js'
import { pathToFileURL } from 'node:url'

/**
 * Reference receiver (DESIGN section 13): the pattern any endpoint should
 * implement —
 *
 *   1. Verify `Webhook-Id` / `Webhook-Timestamp` / `Webhook-Signature`
 *      against the RAW body bytes, comparing in constant time, within a
 *      timestamp tolerance (default 5 minutes).
 *   2. Dedupe on `Webhook-Id`: delivery is at-least-once, so duplicates
 *      are normal, not an error.
 *   3. Answer fast; never assume more requests will explain an earlier one.
 *
 * It can also misbehave on demand so the dispatcher's retries, Retry-After
 * handling, and breaker can be exercised: /flaky, /too-slow, /retry-after,
 * /gone. Everything is in-memory; reset with POST /__reset.
 */

export interface ReceiverOptions {
  secret: string
  toleranceSeconds: number
}

export interface ReceivedWebhook {
  webhookId: string
  firstSeenAt: string
  repeats: number
  payload: unknown
}

/** Reads the `?failRate=0.5&status=429&retryAfterSeconds=120&delayMs=999` style switches. */
function readBehavior(query: Request['query']): {
  failRate: number
  failureStatus: number
  retryAfterSeconds?: number
  delayMs: number
} {
  const failRate = query['failRate'] === undefined ? 0 : Number(query['failRate'])
  const failureStatus = query['status'] === undefined ? 500 : Number(query['status'])
  const retryAfterRaw = query['retryAfterSeconds']
  const delayMs = query['delayMs'] === undefined ? 0 : Number(query['delayMs'])
  return {
    failRate: Number.isFinite(failRate) ? Math.min(Math.max(failRate, 0), 1) : 0,
    failureStatus: Number.isInteger(failureStatus) ? failureStatus : 500,
    retryAfterSeconds:
      retryAfterRaw !== undefined && /^\d+$/.test(String(retryAfterRaw))
        ? Number(retryAfterRaw)
        : undefined,
    delayMs: Number.isFinite(delayMs) ? Math.min(Math.max(delayMs, 0), 60_000) : 0,
  }
}

export function createReceiverApp(options: ReceiverOptions): {
  app: Express
  received: Map<string, ReceivedWebhook>
} {
  const received = new Map<string, ReceivedWebhook>()
  const app = express()
  app.disable('x-powered-by')

  // The signature covers the raw bytes, so bodies are parsed manually.
  const rawBody = express.raw({ type: '*/*', limit: 262_144 })

  /**
   * Shared handler for all hook paths: optionally inject delayed/failed
   * responses BEFORE doing any work (they simulate an unreachable or sick
   * endpoint), otherwise verify and dedupe like a real receiver.
   */
  const handleHook = async (req: Request, res: Response): Promise<void> => {
    const behavior = readBehavior(req.query)
    await new Promise<void>((resolve) => setTimeout(resolve, behavior.delayMs))

    if (Math.random() < behavior.failRate) {
      if (behavior.retryAfterSeconds !== undefined) {
        res.set('Retry-After', String(behavior.retryAfterSeconds))
      }
      res.status(behavior.failureStatus).json({ received: false, injectedFailure: true })
      return
    }

    const verdict = verifyWebhook({
      body: req.body as Buffer,
      webhookId: req.get('webhook-id'),
      webhookTimestamp: req.get('webhook-timestamp'),
      webhookSignature: req.get('webhook-signature'),
      secret: options.secret,
      toleranceSeconds: options.toleranceSeconds,
    })
    if (!verdict.valid) {
      res.status(401).json({ received: false, reason: verdict.reason })
      return
    }

    let payload: unknown = null
    try {
      payload = JSON.parse((req.body as Buffer).toString('utf8'))
    } catch {
      payload = null // verified bytes that are not JSON are still accepted
    }

    const existing = received.get(verdict.webhookId)
    let duplicate = false
    if (existing === undefined) {
      received.set(verdict.webhookId, {
        webhookId: verdict.webhookId,
        firstSeenAt: new Date().toISOString(),
        repeats: 0,
        payload,
      })
    } else {
      duplicate = true
      existing.repeats++
    }
    res.status(200).json({ received: true, duplicate, webhookId: verdict.webhookId })
  }

  app.get('/__health', (_req, res) => {
    res.json({ ok: true, toleranceSeconds: options.toleranceSeconds })
  })

  app.post('/hook', rawBody, handleHook)
  // Misbehavior switches (the dispatcher's exercise equipment):
  app.post('/flaky', rawBody, handleHook) // ?failRate=0.5&status=429&retryAfterSeconds=120
  app.post('/too-slow', rawBody, handleHook) // ?delayMs=5000
  app.post('/retry-after', rawBody, handleHook) // ?retryAfterSeconds=900&status=503
  app.post('/gone', rawBody, (_req, res) => {
    res.status(410).json({ received: false, gone: true })
  })

  app.get('/__received', (_req, res) => {
    res.json([...received.values()])
  })
  app.post('/__reset', (_req, res) => {
    received.clear()
    res.status(204).end()
  })

  return { app, received }
}

// --------- runnable as `npm start` or `tsx server.ts` ---------
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const PORT = Number(process.env['PORT'] ?? 9000)
  const SECRET = process.env['WEBHOOK_SECRET'] ?? 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'
  const TOLERANCE_SECONDS = Number(process.env['TOLERANCE_SECONDS'] ?? 300)
  const { app } = createReceiverApp({ secret: SECRET, toleranceSeconds: TOLERANCE_SECONDS })
  const server = app.listen(PORT, () => {
    console.log(`receiver listening on http://0.0.0.0:${PORT} (secret ${SECRET.slice(0, 10)}...)`)
  })
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0))
    })
  }
}
