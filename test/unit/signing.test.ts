import { describe, expect, it } from 'vitest'
import {
  decodeSigningSecret,
  timingSafeBase64Equal,
  signWebhook,
} from '../../src/domain/signing.js'
import { InvalidSigningSecretError } from '../../src/domain/signing.js'

/**
 * Known-answer vectors from the official Standard Webhooks library
 * (libraries/javascript/src/webhook.test.ts,
 * https://github.com/standard-webhooks/standard-webhooks).
 */
const VEC_ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek'
const VEC_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'
const VEC_TIMESTAMP = 1_614_265_330 // 2021-02-25T15:42:10Z
const VEC_PAYLOAD = '{"test": 2432232314}'
const VEC_SIGNATURE = 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE='

/** Bytes 0..255 (not valid UTF-8) from the same library's binary vector. */
const VEC_BINARY = Uint8Array.from({ length: 256 }, (_, i) => i)
const VEC_BINARY_SIGNATURE = 'v1,sEcZ042G8Crqgxbybb3y0eDxQR3TcfYsk11I1XULhSI='

describe('signWebhook (Standard Webhooks vectors)', () => {
  it('matches the spec known-answer vector', () => {
    expect(signWebhook(VEC_ID, VEC_SECRET, VEC_TIMESTAMP, VEC_PAYLOAD)).toBe(VEC_SIGNATURE)
  })

  it('signs the same for a string and its UTF-8 bytes', () => {
    const payload = '{"test": "ünïcödé ✓"}'
    expect(signWebhook(VEC_ID, VEC_SECRET, VEC_TIMESTAMP, payload)).toBe(
      signWebhook(VEC_ID, VEC_SECRET, VEC_TIMESTAMP, Buffer.from(payload, 'utf8')),
    )
  })

  it('signs a binary payload byte for byte', () => {
    const body = Buffer.from(VEC_BINARY)
    expect(signWebhook(VEC_ID, VEC_SECRET, VEC_TIMESTAMP, body)).toBe(VEC_BINARY_SIGNATURE)
  })

  it('changes when any input changes', () => {
    const base = signWebhook(VEC_ID, VEC_SECRET, VEC_TIMESTAMP, VEC_PAYLOAD)
    expect(signWebhook(VEC_ID, VEC_SECRET, VEC_TIMESTAMP + 1, VEC_PAYLOAD)).not.toBe(base)
    expect(signWebhook(VEC_ID + 'x', VEC_SECRET, VEC_TIMESTAMP, VEC_PAYLOAD)).not.toBe(base)
    expect(signWebhook(VEC_ID, VEC_SECRET, VEC_TIMESTAMP, VEC_PAYLOAD + ' ')).not.toBe(base)
    expect(
      signWebhook(VEC_ID, VEC_SECRET.slice(0, -2) + 'wq', VEC_TIMESTAMP, VEC_PAYLOAD),
    ).not.toBe(base)
  })

  it('signs the bytes, not the buffer capacity or type', () => {
    const exact = Buffer.from('{"a":1}', 'utf8')
    const over = Buffer.alloc(128)
    exact.copy(over)
    expect(signWebhook(VEC_ID, VEC_SECRET, VEC_TIMESTAMP, over.subarray(0, exact.length))).toBe(
      signWebhook(VEC_ID, VEC_SECRET, VEC_TIMESTAMP, exact),
    )
  })
})

describe('decodeSigningSecret', () => {
  it('decodes the spec secret the same with and without the prefix', () => {
    expect(decodeSigningSecret(VEC_SECRET)).toEqual(
      decodeSigningSecret(VEC_SECRET.slice('whsec_'.length)),
    )
    // The spec's demo secret decodes to 24 bytes; length is not a rule.
    expect(decodeSigningSecret(VEC_SECRET)).toHaveLength(24)
  })

  it('rejects empty, unbranded-empty, and non-base64 secrets', () => {
    expect(() => decodeSigningSecret('')).toThrow(InvalidSigningSecretError)
    expect(() => decodeSigningSecret('whsec_')).toThrow(InvalidSigningSecretError)
    expect(() => decodeSigningSecret('not base64!@#')).toThrow(InvalidSigningSecretError)
    expect(() => decodeSigningSecret('whsec_not base64!')).toThrow(InvalidSigningSecretError)
  })
})

describe('timingSafeBase64Equal', () => {
  it('accepts equal MACs and rejects different ones of any length', () => {
    const base = 'g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE='
    expect(timingSafeBase64Equal(base, base)).toBe(true)
    expect(timingSafeBase64Equal(base, 'Ceo5qEr07ixe2NLpvHk3FH9bwy/WavXrAFQ/9tdO6mc=')).toBe(false)
    expect(timingSafeBase64Equal(base, 'short')).toBe(false)
    expect(timingSafeBase64Equal(base, '')).toBe(false)
  })
})
