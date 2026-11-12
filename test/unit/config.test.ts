import { describe, expect, it } from 'vitest'
import { loadApiConfig } from '../../src/config/api.js'
import { loadDispatcherConfig } from '../../src/config/dispatcher.js'
import { loadMaintenanceConfig } from '../../src/config/maintenance.js'

const baseEnv = {
  DATABASE_URL: 'postgres://webhook:webhook@localhost:5432/webhook',
  ENCRYPTION_KEY: '/nfxwkRb9px9u/baXe41g2X1qA/v6ADr22Cj1mfkJ1k=',
  ADMIN_API_KEY: 'whkadmin_local_dev',
}

describe('loadApiConfig', () => {
  it('applies defaults to optional values', () => {
    const config = loadApiConfig(baseEnv)

    expect(config.port).toBe(3000)
    expect(config.logLevel).toBe('info')
    expect(config.maxEndpointsPerTenant).toBe(20)
    expect(config.intakeRatePerMinute).toBe(600)
    expect(config.intakeBurst).toBe(100)
  })

  it('defaults the unsafe flags to off', () => {
    const config = loadApiConfig(baseEnv)

    expect(config.allowInsecureHttp).toBe(false)
    expect(config.allowPrivateTargets).toBe(false)
  })

  it('coerces numeric values from strings', () => {
    const config = loadApiConfig({
      ...baseEnv,
      MAX_ENDPOINTS_PER_TENANT: '5',
    })

    expect(config.maxEndpointsPerTenant).toBe(5)
  })

  it('rejects missing required variables', () => {
    expect(() => loadApiConfig({ ...baseEnv, DATABASE_URL: undefined })).toThrow(
      /Invalid configuration/,
    )
    expect(() => loadApiConfig({ ...baseEnv, ENCRYPTION_KEY: '' })).toThrow(/ENCRYPTION_KEY/)
    expect(() => loadApiConfig({ DATABASE_URL: 'postgres://x' })).toThrow(/ADMIN_API_KEY/)
  })

  it('rejects an unknown log level', () => {
    expect(() => loadApiConfig({ ...baseEnv, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/)
  })
})

describe('loadDispatcherConfig', () => {
  it('applies dispatcher defaults', () => {
    const config = loadDispatcherConfig(baseEnv)

    expect(config.dispatcherConcurrency).toBe(50)
    expect(config.claimBatchSize).toBe(100)
    expect(config.perEndpointClaimCap).toBe(10)
    expect(config.pollIntervalMs).toBe(500)
    expect(config.leaseSeconds).toBe(60)
    expect(config.requestTimeoutMs).toBe(10_000)
    expect(config.breakerThreshold).toBe(5)
    expect(config.breakerCooldownSeconds).toBe(60)
  })

  it('rejects out-of-range numbers', () => {
    expect(() => loadDispatcherConfig({ ...baseEnv, POLL_INTERVAL_MS: '999999' })).toThrow(
      /POLL_INTERVAL_MS/,
    )
  })
})

describe('loadMaintenanceConfig', () => {
  it('applies the sweep defaults', () => {
    const config = loadMaintenanceConfig(baseEnv)

    expect(config.deliveryMaxAgeHours).toBe(72)
    expect(config.autoDisableAfterDays).toBe(5)
    expect(config.retentionDays).toBe(30)
  })

  it('needs no crypto material: maintenance never reads endpoint secrets', () => {
    const { ENCRYPTION_KEY: _omitted, ...envWithoutKey } = baseEnv
    const config = loadMaintenanceConfig(envWithoutKey)
    expect(config.databaseUrl).toBe(baseEnv.DATABASE_URL)
  })
})
