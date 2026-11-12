import {
  coreSchema,
  intInRange,
  loadProcessConfig,
  parseEnv,
  type ProcessConfig,
} from './schema.js'

/**
 * The `maintenance` process's configuration: the core plus the three sweep
 * knobs. No crypto material — maintenance never reads endpoint secrets.
 */

const maintenanceSchema = coreSchema.extend({
  DELIVERY_MAX_AGE_HOURS: intInRange(1, 24 * 365, 72),
  AUTO_DISABLE_AFTER_DAYS: intInRange(1, 365, 5),
  RETENTION_DAYS: intInRange(1, 365, 30),
})

export type MaintenanceEnvConfig = ProcessConfig & {
  deliveryMaxAgeHours: number
  autoDisableAfterDays: number
  retentionDays: number
}

export function loadMaintenanceConfig(
  env: Record<string, string | undefined> = process.env,
): MaintenanceEnvConfig {
  const parsed = parseEnv(maintenanceSchema, env)
  return {
    ...loadProcessConfig(env),
    deliveryMaxAgeHours: parsed.DELIVERY_MAX_AGE_HOURS,
    autoDisableAfterDays: parsed.AUTO_DISABLE_AFTER_DAYS,
    retentionDays: parsed.RETENTION_DAYS,
  }
}
