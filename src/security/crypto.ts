import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16

export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EncryptionKeyError'
  }
}

/** Decode the base64 ENCRYPTION_KEY into its 32 bytes. */
export function decodeEncryptionKey(keyBase64: string): Buffer {
  const decoded = Buffer.from(keyBase64, 'base64')
  if (decoded.length !== KEY_BYTES) {
    throw new EncryptionKeyError(
      `ENCRYPTION_KEY must decode from base64 to exactly ${KEY_BYTES} bytes`,
    )
  }
  return decoded
}

/**
 * AES-256-GCM encrypt, output layout: nonce(12) || ciphertext || tag(16)
 * — exactly what `endpoints.secret_ciphertext` stores (DESIGN section 4).
 */
export function encryptSecret(plaintext: string, key: Buffer): Buffer {
  if (key.length !== KEY_BYTES) throw new EncryptionKeyError('encryption key must be 32 bytes')
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()])
}

/** Decrypt the `nonce || ciphertext || tag` layout; throws on tampering. */
export function decryptSecret(payload: Buffer, key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new EncryptionKeyError('encryption key must be 32 bytes')
  if (payload.length < NONCE_BYTES + TAG_BYTES) {
    throw new EncryptionKeyError('ciphertext payload too short')
  }
  const nonce = payload.subarray(0, NONCE_BYTES)
  const authTag = payload.subarray(payload.length - TAG_BYTES)
  const ciphertext = payload.subarray(NONCE_BYTES, payload.length - TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/** `whsec_<base64 of 32 random bytes>` (DESIGN section 6.2). Shown once. */
export function createSigningSecret(): string {
  return `whsec_${randomBytes(32).toString('base64')}`
}
