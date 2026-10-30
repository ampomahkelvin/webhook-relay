import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Standard Webhooks signing (DESIGN section 6.2). Pure: no I/O, no clock —
 * the caller supplies the timestamp so a retry hours later still passes a
 * receiver's tolerance, and tests can use fixed vectors.
 */

export const SIGNATURE_VERSION = 'v1'

export class InvalidSigningSecretError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidSigningSecretError'
  }
}

/** Signs `HMAC-SHA256(secret, "<id>.<timestamp>.<body>")`, base64-encoded. */
export function signWebhook(
  webhookId: string,
  secret: string,
  timestampSeconds: number,
  body: string | Buffer,
): string {
  const key = decodeSigningSecret(secret)
  const toSign = Buffer.concat([
    Buffer.from(`${webhookId}.${timestampSeconds}.`, 'utf8'),
    Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'),
  ])
  const mac = createHmac('sha256', key).update(toSign).digest('base64')
  return `${SIGNATURE_VERSION},${mac}`
}

/**
 * The secret is `whsec_<base64 of 32 random bytes>`. Receivers' libraries
 * also accept the raw base64 without the prefix (the official library
 * does), so verification treats it as optional — but it must decode to
 * something.
 */
export function decodeSigningSecret(secret: string): Buffer {
  const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret
  if (raw.length === 0) {
    throw new InvalidSigningSecretError('signing secret is empty')
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new InvalidSigningSecretError('signing secret is not valid base64')
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length === 0) {
    throw new InvalidSigningSecretError('signing secret decodes to zero bytes')
  }
  return key
}

/**
 * Constant-time base64 comparison for verifying a MAC. Different lengths
 * cannot be compared by timingSafeEqual; returning `false` early on length
 * is standard practice (the official library does the same) — a length
 * difference already tells an attacker nothing about the MAC bytes.
 */
export function timingSafeBase64Equal(a: string, b: string): boolean {
  const left = Buffer.from(a, 'base64')
  const right = Buffer.from(b, 'base64')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
