import { z } from 'zod'
import {
  coreSchema,
  intInRange,
  loadProcessConfig,
  parseEnv,
  type ProcessConfig,
} from './schema.js'

/**
 * The `dispatcher` process's configuration: the core plus the claim/send
 * tuning (concurrency, batch, leases, breaker) and the secret-box key.
 */

const dispatcherSchema = coreSchema.extend({
  ENCRYPTION_KEY: z
    .string()
    .min(1)
    .refine((value) => Buffer.from(value, 'base64').length === 32, {
      message: 'must decode from base64 to exactly 32 bytes',
    }),

  DISPATCHER_CONCURRENCY: intInRange(1, 1000, 50),
  CLAIM_BATCH_SIZE: intInRange(1, 1000, 100),
  PER_ENDPOINT_CLAIM_CAP: intInRange(1, 1000, 10),
  POLL_INTERVAL_MS: intInRange(1, 60_000, 500),
  LEASE_SECONDS: intInRange(1, 3600, 60),
  REQUEST_TIMEOUT_MS: intInRange(100, 120_000, 10_000),
  BREAKER_THRESHOLD: intInRange(1, 100, 5),
  BREAKER_COOLDOWN_SECONDS: intInRange(1, 3600, 60),
})

export type DispatcherEnvConfig = ProcessConfig & {
  encryptionKey: string
  dispatcherConcurrency: number
  claimBatchSize: number
  perEndpointClaimCap: number
  pollIntervalMs: number
  leaseSeconds: number
  requestTimeoutMs: number
  breakerThreshold: number
  breakerCooldownSeconds: number
}

export function loadDispatcherConfig(
  env: Record<string, string | undefined> = process.env,
): DispatcherEnvConfig {
  const parsed = parseEnv(dispatcherSchema, env)
  return {
    ...loadProcessConfig(env),
    encryptionKey: parsed.ENCRYPTION_KEY,
    dispatcherConcurrency: parsed.DISPATCHER_CONCURRENCY,
    claimBatchSize: parsed.CLAIM_BATCH_SIZE,
    perEndpointClaimCap: parsed.PER_ENDPOINT_CLAIM_CAP,
    pollIntervalMs: parsed.POLL_INTERVAL_MS,
    leaseSeconds: parsed.LEASE_SECONDS,
    requestTimeoutMs: parsed.REQUEST_TIMEOUT_MS,
    breakerThreshold: parsed.BREAKER_THRESHOLD,
    breakerCooldownSeconds: parsed.BREAKER_COOLDOWN_SECONDS,
  }
}
