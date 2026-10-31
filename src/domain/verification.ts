import { signWebhook, timingSafeBase64Equal } from './signing.js'

/**
 * Receiver-side verification (DESIGN section 6.2 "Receivers must compare in
 * constant time and reject timestamps outside the tolerance"). Pure and
 * clock-injectable; the sample receiver (examples/receiver) uses this as
 * its reference implementation.
 */

export type VerifyFailureReason =
  | 'missing_webhook_id'
  | 'missing_webhook_timestamp'
  | 'missing_webhook_signature'
  | 'malformed_timestamp'
  | 'timestamp_out_of_tolerance'
  | 'invalid_signature'

export interface WebhookVerifyInput {
  body: string | Buffer
  webhookId: string | undefined
  webhookTimestamp: string | undefined
  webhookSignature: string | undefined
  secret: string
  /** Allowed clock skew in both directions. The spec's default is 5 minutes. */
  toleranceSeconds: number
  /** Injected clock (unix seconds); defaults to the caller's `now`. */
  nowSeconds?: number
}

export type VerifyResult =
  { valid: true; webhookId: string } | { valid: false; reason: VerifyFailureReason }

const SIGNATURE_PATTERN = /^v1,(.+)$/

/**
 * Verifies the `Webhook-Id` / `Webhook-Timestamp` / `Webhook-Signature`
 * triple against the raw request body bytes. The signature header may carry
 * a space-separated list (rotation overlap); entries that are not
 * `v1,<base64>` are skipped, and the request only verifies if one of them
 * matches the computed MAC.
 */
export function verifyWebhook(input: WebhookVerifyInput): VerifyResult {
  const { body, secret, toleranceSeconds } = input
  if (!input.webhookId) return { valid: false, reason: 'missing_webhook_id' }
  if (input.webhookTimestamp === undefined || input.webhookTimestamp === '') {
    return { valid: false, reason: 'missing_webhook_timestamp' }
  }
  if (input.webhookSignature === undefined || input.webhookSignature === '') {
    return { valid: false, reason: 'missing_webhook_signature' }
  }
  if (!/^[0-9]+$/.test(input.webhookTimestamp)) {
    return { valid: false, reason: 'malformed_timestamp' }
  }

  const timestamp = Number(input.webhookTimestamp)
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return { valid: false, reason: 'timestamp_out_of_tolerance' }
  }

  const candidates = input.webhookSignature
    .split(' ')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  if (candidates.length === 0) return { valid: false, reason: 'invalid_signature' }

  const expected = signWebhook(input.webhookId, secret, timestamp, body)
  const expectedMac = expected.slice('v1,'.length)

  for (const candidate of candidates) {
    const match = SIGNATURE_PATTERN.exec(candidate)
    if (match === null) continue // malformed entries are skipped, not fatal
    if (timingSafeBase64Equal(expectedMac, match[1] as string)) {
      return { valid: true, webhookId: input.webhookId }
    }
  }
  return { valid: false, reason: 'invalid_signature' }
}
