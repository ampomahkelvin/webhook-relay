import type { Pool } from 'pg'
import {
  createSigningSecret,
  decodeEncryptionKey,
  encryptSecret,
} from '../../src/security/crypto.js'
import { TEST_ENCRYPTION_KEY } from './test-app.js'

/** Seed helpers: build real tenants/endpoints/events/deliveries directly. */

export interface SeedWorkload {
  tenantId: string
  endpointId: string
  /** The plaintext signing secret. */
  secret: string
  deliveryIds: string[]
}

export interface SeedOptions {
  count: number
  endpointUrl: string
  eventTypes?: string[]
  /** Plaintext signing secret; a fresh one is generated when omitted. */
  secret?: string
  endpointStatus?: 'enabled' | 'disabled'
  eventPayload?: string
  /** First claim time; defaults to now() (due immediately). */
  nextAttemptAt?: Date
}

export async function seedWorkload(pool: Pool, options: SeedOptions): Promise<SeedWorkload> {
  const secret = options.secret ?? createSigningSecret()
  const key = decodeEncryptionKey(TEST_ENCRYPTION_KEY)
  const status = options.endpointStatus ?? 'enabled'

  const tenants = await pool.query<{ id: string }>(
    'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
    [`seed-${Date.now()}-${Math.floor(Math.random() * 1e9)}`],
  )
  const tenantId = tenants.rows[0]!.id

  const endpoints = await pool.query<{ id: string }>(
    `INSERT INTO endpoints (tenant_id, url, event_types, secret_ciphertext, status, disabled_reason)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      tenantId,
      options.endpointUrl,
      options.eventTypes ?? ['*'],
      encryptSecret(secret, key),
      status,
      status === 'disabled' ? 'manual' : null,
    ],
  )
  const endpointId = endpoints.rows[0]!.id

  const result = await pool.query<{ id: string }>(
    `WITH ev AS (
       INSERT INTO events (tenant_id, event_type, payload, idempotency_key, request_hash)
       SELECT $1::uuid, 'demo.ping', $5::jsonb, $2 || g::text, sha256(int4send(g))
       FROM generate_series(1, $3::int) g
       RETURNING id
     )
     INSERT INTO deliveries (event_id, endpoint_id, next_attempt_at)
     SELECT ev.id, $4::uuid, COALESCE($6::timestamptz, now()) FROM ev
     RETURNING id`,
    [
      tenantId,
      `seed-${endpointId}-`,
      options.count,
      endpointId,
      options.eventPayload ?? '{"v":1}',
      options.nextAttemptAt ?? null,
    ],
  )

  return {
    tenantId,
    endpointId,
    secret,
    deliveryIds: result.rows.map((row) => row.id),
  }
}
