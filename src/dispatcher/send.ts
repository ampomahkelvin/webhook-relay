import { decodeEncryptionKey, decryptSecret } from '../security/crypto.js'
import {
  sendThroughSsrfClient,
  DEFAULT_MAX_RESPONSE_BYTES,
  type SendResult,
} from '../security/ssrf-client.js'
import { buildOutboundRequest } from '../domain/outbound-request.js'
import { classifyAttempt, type AttemptOutcome, type HttpLikeHeaders } from '../domain/classify.js'
import type { DeliveryDetails } from './claim.js'

/**
 * One attempt: build, sign, send through the SSR-safe client, classify
 * (DESIGN section 6.2 + 6.3). This does not touch the database — the
 * dispatcher calls `recordAttempt` with the outcome, so a send and its
 * recording never share a transaction or a lifetime assumption.
 */

export interface SendCallOptions {
  encryptionKeyBase64: string
  requestTimeoutMs: number
  maxResponseBytes?: number
  maxSnippetBytes?: number
  allowInsecureHttp: boolean
  allowPrivateTargets: boolean
  nowMs?: number
}

export interface AttemptSent {
  outcome: AttemptOutcome
  statusCode?: number
  errorKind?: string
  /** Response snippet, already capped for storage (DESIGN: at most 1 KB). */
  snippet?: Buffer
  startedAtMs: number
  durationMs: number
}

export async function sendDeliveryAttempt(
  details: DeliveryDetails,
  options: SendCallOptions,
): Promise<AttemptSent> {
  const startedAtMs = Date.now()
  type WireResult = {
    statusCode?: number
    headers?: HttpLikeHeaders
    kind?: string
    snippet?: Buffer
  }
  let response: WireResult

  try {
    const secret = decryptSecret(
      details.secretCiphertext,
      decodeEncryptionKey(options.encryptionKeyBase64),
    )
    const request = buildOutboundRequest(
      {
        eventId: details.eventId,
        eventType: details.eventType,
        createdAtIso: details.eventCreatedAt.toISOString(),
        payload: details.payload,
      },
      { url: details.endpointUrl, secret },
      { allowInsecureHttp: options.allowInsecureHttp },
    )
    const result: SendResult = await sendThroughSsrfClient({
      url: request.target.toString(),
      headers: request.headers,
      body: request.body,
      requestTimeoutMs: options.requestTimeoutMs,
      maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      allowPrivateTargets: options.allowPrivateTargets,
    })

    if (result.ok) {
      response = {
        statusCode: result.statusCode,
        headers: result.headers,
        snippet: result.snippet.subarray(0, options.maxSnippetBytes ?? 1024),
      }
    } else {
      response = { kind: result.kind }
    }
  } catch {
    // Endpoint-configuration problems (invalid URL, bad secret) fail the
    // attempt like a transport error and are retried on the schedule.
    response = { kind: 'connection' }
  }

  const durationMs = Date.now() - startedAtMs
  const outcome = classifyAttempt({
    statusCode: response.statusCode,
    errorKind: response.kind as never,
    headers: response.headers,
  })
  return {
    outcome,
    statusCode: response.statusCode,
    errorKind: response.kind,
    snippet: response.snippet,
    startedAtMs,
    durationMs,
  }
}
