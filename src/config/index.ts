import { z } from 'zod'

/** Boolean flag parsed from "true"/"false" strings in the environment. */
const booleanFlag = (defaultValue: boolean) =>
  z
    .enum(['true', 'false'])
    .default(defaultValue ? 'true' : 'false')
    .transform((value) => value === 'true')

const intInRange = (min: number, max: number, defaultValue: number) =>
  z.coerce.number().int().min(min).max(max).default(defaultValue)

const envSchema = z.object({
  // --- Required ---
  DATABASE_URL: z.string().min(1),
  ENCRYPTION_KEY: z
    .string()
    .min(1)
    .refine((value) => Buffer.from(value, 'base64').length === 32, {
      message: 'must decode from base64 to exactly 32 bytes',
    }),
  ADMIN_API_KEY: z.string().min(1),

  // --- Server ---
  PORT: intInRange(1, 65535, 3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // --- Intake ---
  MAX_ENDPOINTS_PER_TENANT: intInRange(1, 1000, 20),
  INTAKE_RATE_PER_MINUTE: intInRange(0, 100_000_000, 600),
  INTAKE_BURST: intInRange(1, 100_000_000, 100),

  // --- Dispatcher ---
  DISPATCHER_CONCURRENCY: intInRange(1, 1000, 50),
  CLAIM_BATCH_SIZE: intInRange(1, 1000, 100),
  PER_ENDPOINT_CLAIM_CAP: intInRange(1, 1000, 10),
  POLL_INTERVAL_MS: intInRange(1, 60_000, 500),
  LEASE_SECONDS: intInRange(1, 3600, 60),
  REQUEST_TIMEOUT_MS: intInRange(100, 120_000, 10_000),
  BREAKER_THRESHOLD: intInRange(1, 100, 5),
  BREAKER_COOLDOWN_SECONDS: intInRange(1, 3600, 60),

  // --- Maintenance ---
  DELIVERY_MAX_AGE_HOURS: intInRange(1, 24 * 365, 72),
  AUTO_DISABLE_AFTER_DAYS: intInRange(1, 365, 5),
  RETENTION_DAYS: intInRange(1, 365, 30),

  // --- Development escape hatches (both default to safe) ---
  ALLOW_INSECURE_HTTP: booleanFlag(false),
  ALLOW_PRIVATE_TARGETS: booleanFlag(false),
})

export type Config = {
  databaseUrl: string
  encryptionKey: string
  adminApiKey: string
  port: number
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'
  maxEndpointsPerTenant: number
  intakeRatePerMinute: number
  intakeBurst: number
  dispatcherConcurrency: number
  claimBatchSize: number
  perEndpointClaimCap: number
  pollIntervalMs: number
  leaseSeconds: number
  requestTimeoutMs: number
  breakerThreshold: number
  breakerCooldownSeconds: number
  deliveryMaxAgeHours: number
  autoDisableAfterDays: number
  retentionDays: number
  allowInsecureHttp: boolean
  allowPrivateTargets: boolean
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * Parse and validate the configuration from an environment-like object.
 * `env` is injectable so tests can pass synthetic values.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = envSchema.safeParse(env)
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    throw new ConfigError(`Invalid configuration: ${details}`)
  }
  const parsed = result.data
  return {
    databaseUrl: parsed.DATABASE_URL,
    encryptionKey: parsed.ENCRYPTION_KEY,
    adminApiKey: parsed.ADMIN_API_KEY,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    maxEndpointsPerTenant: parsed.MAX_ENDPOINTS_PER_TENANT,
    intakeRatePerMinute: parsed.INTAKE_RATE_PER_MINUTE,
    intakeBurst: parsed.INTAKE_BURST,
    dispatcherConcurrency: parsed.DISPATCHER_CONCURRENCY,
    claimBatchSize: parsed.CLAIM_BATCH_SIZE,
    perEndpointClaimCap: parsed.PER_ENDPOINT_CLAIM_CAP,
    pollIntervalMs: parsed.POLL_INTERVAL_MS,
    leaseSeconds: parsed.LEASE_SECONDS,
    requestTimeoutMs: parsed.REQUEST_TIMEOUT_MS,
    breakerThreshold: parsed.BREAKER_THRESHOLD,
    breakerCooldownSeconds: parsed.BREAKER_COOLDOWN_SECONDS,
    deliveryMaxAgeHours: parsed.DELIVERY_MAX_AGE_HOURS,
    autoDisableAfterDays: parsed.AUTO_DISABLE_AFTER_DAYS,
    retentionDays: parsed.RETENTION_DAYS,
    allowInsecureHttp: parsed.ALLOW_INSECURE_HTTP,
    allowPrivateTargets: parsed.ALLOW_PRIVATE_TARGETS,
  }
}
