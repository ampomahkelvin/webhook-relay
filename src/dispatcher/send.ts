import { decodeEncryptionKey, decryptSecret } from '../infra/secret-box.js'
import {
  sendThroughSsrfClient,
  DEFAULT_MAX_RESPONSE_BYTES,
  type SendResult,
} from '../infra/ssrf-client.js'
import { buildOutboundRequest } from '../domain/outbound-request.js'
import { classifyAttempt, type AttemptOutcome, type HttpLikeHeaders } from '../domain/classify.js'
import type { DeliveryDetails } from '../db/delivery-queue.js'

/** Cap of the stored response snippet (DESIGN: at most 1 KB). */
const MAX_SNIPPET_BYTES = 1024

/**
 * Postgres `text` accepts only valid UTF-8 without NUL bytes, so a raw
 * body slice must not go to the record statement as bytes: a body cut in
 * the middle of a multi-byte character at the 1 KB boundary, binary or
 * compressed bytes (e.g. gzip), or a NUL would make the attempt's INSERT
 * throw — and (before this sanitizer) a thrown record looked like a worker
 * error, re-sending a delivery the receiver had already answered.
 *
 * Truncate in bytes FIRST, then decode leniently: an invalid sequence
 * becomes U+FFFD (never an error), and NUL becomes U+FFFD too. The result
 * is a string Postgres always accepts, at most `maxBytes` characters.
 */
export function toSnippet(bytes: Buffer, maxBytes = MAX_SNIPPET_BYTES): string {
  return bytes.subarray(0, maxBytes).toString('utf8').replaceAll('\u0000', '\uFFFD')
}

/**
 * One attempt: build, sign, send through the SSR-safe client, classify
 * (DESIGN section 6.2 + 6.3). This does not touch the database — the
 * dispatcher calls `recordAttempt` with the outcome, so a send and its
 * recording never share a transaction or a lifetime assumption.
 */

export interface SendCallOptions {
  encryptionKeyBase64: string
  requestTimeoutMs: number
  allowInsecureHttp: boolean
  allowPrivateTargets: boolean
}

export interface AttemptSent {
  outcome: AttemptOutcome
  statusCode?: number
  errorKind?: string
  /** Response snippet, already sanitized for storage (DESIGN: at most 1 KB). */
  snippet?: string
  startedAtMs: number
  durationMs: number
  /**
   * The build/sign/decrypt failure message when the attempt died before
   * reaching the wire. Recorded for the logs — it must not be swallowed,
   * but it is not a wire error kind, so the classifier still sees
   * 'connection'.
   */
  internalError?: string
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
    snippet?: string
  }
  let response: WireResult
  let internalError: string | undefined

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
      maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
      allowPrivateTargets: options.allowPrivateTargets,
    })

    if (result.ok) {
      response = {
        statusCode: result.statusCode,
        headers: result.headers,
        snippet: toSnippet(result.snippet),
      }
    } else {
      response = { kind: result.kind }
    }
  } catch (error) {
    // Endpoint-configuration problems (invalid URL, bad secret) fail the
    // attempt like a transport error and are retried on the schedule —
    // but with the reason visible instead of collapsed into the kind.
    response = { kind: 'connection' }
    internalError = (error as Error).message
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
    internalError,
  }
}
