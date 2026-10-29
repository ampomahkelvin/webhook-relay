import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/index.js'

const baseEnv = {
  DATABASE_URL: 'postgres://webhook:webhook@localhost:5432/webhook',
  ENCRYPTION_KEY: 'nfxwkRb9px9u/baXe41g2X1qA/v6ADr22Cj1mfkJ1k=',
  ADMIN_API_KEY: 'whkadmin_local_dev',
}

describe('loadConfig', () => {
  it('applies defaults to optional values', () => {
    const config = loadConfig(baseEnv)

    expect(config.port).toBe(3000)
    expect(config.logLevel).toBe('info')
    expect(config.maxEndpointsPerTenant).toBe(20)
    expect(config.dispatcherConcurrency).toBe(50)
    expect(config.claimBatchSize).toBe(100)
    expect(config.perEndpointClaimCap).toBe(10)
    expect(config.pollIntervalMs).toBe(500)
    expect(config.leaseSeconds).toBe(60)
    expect(config.requestTimeoutMs).toBe(10_000)
    expect(config.breakerThreshold).toBe(5)
    expect(config.breakerCooldownSeconds).toBe(60)
    expect(config.deliveryMaxAgeHours).toBe(72)
    expect(config.autoDisableAfterDays).toBe(5)
    expect(config.retentionDays).toBe(30)
  })

  it('defaults the unsafe flags to off', () => {
    const config = loadConfig(baseEnv)

    expect(config.allowInsecureHttp).toBe(false)
    expect(config.allowPrivateTargets).toBe(false)
  })

  it('coerces numeric values from strings', () => {
    const config = loadConfig({
      ...baseEnv,
      POLL_INTERVAL_MS: '250',
      MAX_ENDPOINTS_PER_TENANT: '5',
    })

    expect(config.pollIntervalMs).toBe(250)
    expect(config.maxEndpointsPerTenant).toBe(5)
  })

  it('parses boolean flags', () => {
    const on = loadConfig({ ...baseEnv, ALLOW_PRIVATE_TARGETS: 'true' })
    const off = loadConfig({ ...baseEnv, ALLOW_PRIVATE_TARGETS: 'false' })

    expect(on.allowPrivateTargets).toBe(true)
    expect(off.allowPrivateTargets).toBe(false)
  })

  it('rejects missing required variables', () => {
    expect(() => loadConfig({ ...baseEnv, DATABASE_URL: undefined })).toThrow(
      /Invalid configuration/,
    )
    expect(() => loadConfig({ ...baseEnv, ENCRYPTION_KEY: '' })).toThrow(/ENCRYPTION_KEY/)
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x' })).toThrow(/ADMIN_API_KEY/)
  })

  it('rejects out-of-range numbers', () => {
    expect(() => loadConfig({ ...baseEnv, PORT: '0' })).toThrow(/PORT/)
    expect(() => loadConfig({ ...baseEnv, POLL_INTERVAL_MS: '999999' })).toThrow(/POLL_INTERVAL_MS/)
  })

  it('rejects an unknown log level', () => {
    expect(() => loadConfig({ ...baseEnv, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/)
  })
})
