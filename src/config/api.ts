import { z } from 'zod'
import {
  coreSchema,
  intInRange,
  loadProcessConfig,
  parseEnv,
  type ProcessConfig,
} from './schema.js'

/**
 * The `api` process's configuration: the core plus intake validation,
 * rate limiting, and the admin/intake authentication material.
 */

const apiSchema = coreSchema.extend({
  ENCRYPTION_KEY: z
    .string()
    .min(1)
    .refine((value) => Buffer.from(value, 'base64').length === 32, {
      message: 'must decode from base64 to exactly 32 bytes',
    }),
  ADMIN_API_KEY: z.string().min(1),

  // --- Intake ---
  MAX_ENDPOINTS_PER_TENANT: intInRange(1, 1000, 20),
  INTAKE_RATE_PER_MINUTE: intInRange(0, 100_000_000, 600),
  INTAKE_BURST: intInRange(1, 100_000_000, 100),
})

export type ApiConfig = ProcessConfig & {
  encryptionKey: string
  adminApiKey: string
  maxEndpointsPerTenant: number
  intakeRatePerMinute: number
  intakeBurst: number
}

export function loadApiConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  const parsed = parseEnv(apiSchema, env)
  return {
    ...loadProcessConfig(env),
    encryptionKey: parsed.ENCRYPTION_KEY,
    adminApiKey: parsed.ADMIN_API_KEY,
    maxEndpointsPerTenant: parsed.MAX_ENDPOINTS_PER_TENANT,
    intakeRatePerMinute: parsed.INTAKE_RATE_PER_MINUTE,
    intakeBurst: parsed.INTAKE_BURST,
  }
}
