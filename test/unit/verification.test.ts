import { describe, expect, it } from 'vitest'
import { verifyWebhook } from '../../src/domain/verification.js'
import { signWebhook } from '../../src/domain/signing.js'

/** Fixed clock inside any sane tolerance. */
const NOW = 1_700_000_000
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'
const ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek'
const BODY = '{"test": 2432232314}'

function build(input: {
  id?: string
  timestamp?: number
  body?: string | Buffer
  signature?: string
}) {
  const timestamp = input.timestamp ?? NOW
  const body = input.body ?? BODY
  const id = input.id ?? ID
  // Sign with the same implementation the sender uses; the known-answer
  // vectors prove that implementation matches the spec (signing.test.ts).
  const signature = `v1,${signWebhook(id, SECRET, timestamp, body).slice('v1,'.length)}`
  return {
    body,
    // `in` distinguishes "not provided" from "provided as undefined", so
    // the missing-header tests can strip a header deliberately.
    webhookId: 'id' in input ? input.id : ID,
    webhookTimestamp:
      'timestamp' in input
        ? input.timestamp === undefined
          ? undefined
          : String(input.timestamp)
        : String(timestamp),
    webhookSignature: 'signature' in input ? input.signature : signature,
    secret: SECRET,
    toleranceSeconds: 300,
    nowSeconds: NOW,
  }
}

describe('verifyWebhook', () => {
  const valid = build({})
  it('accepts a correctly signed request', () => {
    expect(verifyWebhook(valid)).toEqual({ valid: true, webhookId: ID })
  })

  it('rejects captured-request replay via the timestamp tolerance', () => {
    const old = build({ timestamp: NOW - 301 })
    expect(verifyWebhook(old)).toEqual({
      valid: false,
      reason: 'timestamp_out_of_tolerance',
    })
    const future = build({ timestamp: NOW + 301 })
    expect(verifyWebhook(future).valid).toBe(false)
    // at the exact boundary it is still fine
    expect(verifyWebhook(build({ timestamp: NOW - 300 })).valid).toBe(true)
  })

  it('rejects a different body with the same headers', () => {
    expect(verifyWebhook({ ...valid, body: BODY + ' ' }).valid).toBe(false)
    const tampered = Buffer.from(BODY, 'utf8')
    tampered[6] = 0x34
    expect(verifyWebhook({ ...valid, body: tampered }).valid).toBe(false)
  })

  it('rejects missing headers and malformed timestamps', () => {
    expect(verifyWebhook({ ...valid, webhookId: undefined })).toMatchObject({
      valid: false,
      reason: 'missing_webhook_id',
    })
    expect(verifyWebhook({ ...valid, webhookTimestamp: undefined })).toMatchObject({
      reason: 'missing_webhook_timestamp',
    })
    expect(verifyWebhook({ ...valid, webhookSignature: undefined })).toMatchObject({
      reason: 'missing_webhook_signature',
    })
    expect(verifyWebhook({ ...valid, webhookTimestamp: 'hello' })).toMatchObject({
      reason: 'malformed_timestamp',
    })
    expect(verifyWebhook({ ...valid, webhookTimestamp: '-1' })).toMatchObject({
      reason: 'malformed_timestamp',
    })
  })

  it('rejects wrong, partial, and unversioned signatures', () => {
    expect(verifyWebhook({ ...valid, webhookSignature: 'v1,dawfeoifkpqwoekfpqoekf' }).valid).toBe(
      false,
    )
    const good = valid.webhookSignature as string
    expect(verifyWebhook({ ...valid, webhookSignature: good.slice(0, 8) }).valid).toBe(false)
    expect(verifyWebhook({ ...valid, webhookSignature: good.replace('v1,', '') }).valid).toBe(false)
    expect(verifyWebhook({ ...valid, webhookSignature: 'v1,' }).valid).toBe(false)
    expect(verifyWebhook({ ...valid, webhookSignature: `v2,${good.slice(3)}` }).valid).toBe(false)
  })

  it('accepts the one valid signature in a space-separated list', () => {
    // The official multi-sig vector: valid entry among decoys and junk.
    const signature = valid.webhookSignature as string
    const list = [
      'v1,Ceo5qEr07ixe2NLpvHk3FH9bwy/WavXrAFQ/9tdO6mc=',
      'v2,Ceo5qEr07ixe2NLpvHk3FH9bwy/WavXrAFQ/9tdO6mc=',
      'v1',
      'v1,not-base64!',
      signature,
    ].join(' ')
    expect(verifyWebhook({ ...valid, webhookSignature: list }).valid).toBe(true)
  })

  it('accepts secrets with or without the whsec_ prefix', () => {
    const branded = verifyWebhook({ ...valid, secret: SECRET }).valid
    const unbranded = verifyWebhook({
      ...valid,
      secret: SECRET.slice('whsec_'.length),
    }).valid
    expect(branded).toBe(true)
    expect(unbranded).toBe(true)
  })

  it('verifies binary body bytes', () => {
    const body = Buffer.from(Uint8Array.from({ length: 256 }, (_, i) => i))
    const binary = build({ body })
    expect(verifyWebhook(binary).valid).toBe(true)
    const changed = Buffer.from(body)
    changed[255] = 0
    expect(verifyWebhook({ ...binary, body: changed }).valid).toBe(false)
  })
})
