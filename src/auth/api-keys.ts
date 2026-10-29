import { createHash, randomBytes } from 'node:crypto'

export interface IssuedApiKey {
  /** Full secret, shown once, sent as `Authorization: Bearer whk_...`. */
  key: string
  /** SHA-256 of the full key, what gets stored in `api_keys.key_hash`. */
  keyHash: Buffer
  /** First characters of the key, for identifying it in listings. */
  keyPrefix: string
}

/** `sha256(key)` — fast hash is appropriate for high-entropy keys (DESIGN section 9). */
export function hashApiKey(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest()
}

/** Generate a high-entropy API key in the `whk_<base64url(32 bytes)>` form. */
export function generateApiKey(): IssuedApiKey {
  const key = `whk_${randomBytes(32).toString('base64url')}`
  return { key, keyHash: hashApiKey(key), keyPrefix: key.slice(0, 8) }
}
