import { z } from 'zod'

/**
 * Config building blocks (`config/schema.ts`). Each process validates ONLY
 * the variables it uses (`api.ts`, `dispatcher.ts`, `maintenance.ts`); the
 * shared core — database, logging, listen port, and the safety flags —
 * lives here so the three loaders cannot drift apart.
 */

/** Boolean flag parsed from "true"/"false" strings in the environment. */
export const booleanFlag = (defaultValue: boolean) =>
  z
    .enum(['true', 'false'])
    .default(defaultValue ? 'true' : 'false')
    .transform((value) => value === 'true')

export const intInRange = (min: number, max: number, defaultValue: number) =>
  z.coerce.number().int().min(min).max(max).default(defaultValue)

/** Every process: its database pool, logging, and its HTTP surface. */
export const coreSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: intInRange(1, 65535, 3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Development escape hatches (both default to safe).
  ALLOW_INSECURE_HTTP: booleanFlag(false),
  ALLOW_PRIVATE_TARGETS: booleanFlag(false),
})

export type ProcessConfig = {
  databaseUrl: string
  port: number
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'
  allowInsecureHttp: boolean
  allowPrivateTargets: boolean
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** Parse an env-like object against `schema`; a failure throws ConfigError. */
export function parseEnv<S extends z.ZodType>(
  schema: S,
  env: Record<string, string | undefined>,
): z.infer<S> {
  const result = schema.safeParse(env)
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    throw new ConfigError(`Invalid configuration: ${details}`)
  }
  return result.data
}

/** The core config every process needs (migrate uses this alone). */
export function loadProcessConfig(
  env: Record<string, string | undefined> = process.env,
): ProcessConfig {
  const parsed = parseEnv(coreSchema, env)
  return {
    databaseUrl: parsed.DATABASE_URL,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    allowInsecureHttp: parsed.ALLOW_INSECURE_HTTP,
    allowPrivateTargets: parsed.ALLOW_PRIVATE_TARGETS,
  }
}
