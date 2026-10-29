import { describe, expect, it } from 'vitest'
import {
  createSigningSecret,
  decryptSecret,
  decodeEncryptionKey,
  encryptSecret,
} from '../../src/security/crypto.js'

const KEY = '/nfxwkRb9px9u/baXe41g2X1qA/v6ADr22Cj1mfkJ1k='

describe('decodeEncryptionKey', () => {
  it('decodes base64 to 32 bytes', () => {
    expect(decodeEncryptionKey(KEY)).toHaveLength(32)
  })

  it('rejects keys of other lengths', () => {
    expect(() => decodeEncryptionKey(Buffer.alloc(16).toString('base64'))).toThrow(
      /exactly 32 bytes/,
    )
    expect(() => decodeEncryptionKey(Buffer.alloc(33).toString('base64'))).toThrow(
      /exactly 32 bytes/,
    )
  })
})

describe('encryptSecret / decryptSecret', () => {
  const key = decodeEncryptionKey(KEY)

  it('round-trips', () => {
    const secret = 'whsec_abcd1234'
    expect(decryptSecret(encryptSecret(secret, key), key)).toBe(secret)
  })

  it('round-trips unicode and long values', () => {
    const secret = 'whsec_ünïcode ✓ ' + 'x'.repeat(200)
    expect(decryptSecret(encryptSecret(secret, key), key)).toBe(secret)
  })

  it('ciphertext differs from plaintext and is not empty', () => {
    const secret = 'whsec_abcdefgh'
    const payload = encryptSecret(secret, key)
    expect(payload.length).toBe(12 + secret.length + 16)
    expect(payload.includes(Buffer.from(secret))).toBe(false) // nonce||tag means plaintext never appears verbatim
  })

  it('uses a fresh nonce each time', () => {
    const secret = 'same'
    const a = encryptSecret(secret, key)
    const b = encryptSecret(secret, key)
    expect(a.equals(b)).toBe(false)
    expect(decryptSecret(b, key)).toBe(secret) // both decrypt
  })

  it('throws when the payload was tampered with', () => {
    const payload = encryptSecret('whsec_topsecret', key)
    payload.writeUInt8(payload.readUInt8(payload.length - 3) ^ 0xff, payload.length - 3)
    expect(() => decryptSecret(payload, key)).toThrow()
  })

  it('throws when the ciphertext body was tampered with', () => {
    const payload = encryptSecret('whsec_topsecret', key)
    payload.writeUInt8(payload.readUInt8(5) ^ 0x01, 5)
    expect(() => decryptSecret(payload, key)).toThrow()
  })
})

describe('createSigningSecret', () => {
  it('has the whsec_ prefix and 44 base64 chars', () => {
    const secret = createSigningSecret()
    expect(secret.startsWith('whsec_')).toBe(true)
    expect(secret.length).toBe('whsec_'.length + 44) // base64(32 bytes)
  })

  it('generates distinct secrets', () => {
    const a = createSigningSecret()
    const b = createSigningSecret()
    expect(a).not.toBe(b)
  })
})
