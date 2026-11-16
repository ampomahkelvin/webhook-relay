import { describe, expect, it, vi, type Mock } from 'vitest'
import type { Pool } from 'pg'
import type { Logger } from '../../src/logger.js'
import type { AttemptSent } from '../../src/dispatcher/send.js'
import type { DispatcherConfig, DispatcherStats } from '../../src/dispatcher/ports.js'
import { createProcessDelivery } from '../../src/dispatcher/process-delivery.js'
import type { ClaimedDelivery } from '../../src/db/delivery-claim.js'
import type { DeliveryDetails } from '../../src/db/delivery-details.js'

/**
 * Record-retry budget (N1). The send is stubbed: the budget lives entirely
 * in what happens AFTER a send, and a stub keeps the unit off the network.
 */
vi.mock('../../src/dispatcher/send.js', () => ({
  sendDeliveryAttempt: vi.fn(async (): Promise<AttemptSent> => ({
    outcome: { kind: 'succeeded' },
    statusCode: 200,
    startedAtMs: 1_000,
    durationMs: 5,
  })),
}))

/** A pool whose recording path always fails (database outage). */
const brokenPool = (): Pool =>
  ({
    connect: async () => {
      throw new Error('db unavailable')
    },
  }) as unknown as Pool

const fakeLogger = (): { logger: Logger; warns: Mock; errors: Mock } => {
  const warns = vi.fn()
  const errors = vi.fn()
  const logger = { info: vi.fn(), warn: warns, error: errors, debug: vi.fn() } as unknown as Logger
  return { logger, warns, errors }
}

/** How many log lines with this `deliveryId` the mock saw. */
const forDelivery = (log: Mock, deliveryId: string): number =>
  log.mock.calls.filter((call) => (call[0] as { deliveryId: string }).deliveryId === deliveryId)
    .length

const CONFIG: DispatcherConfig = {
  encryptionKeyBase64: 'A'.repeat(44),
  requestTimeoutMs: 1_000,
  allowInsecureHttp: true,
  allowPrivateTargets: true,
  concurrency: 1,
  batchSize: 10,
  perEndpointClaimCap: 10,
  pollIntervalMs: 100,
  leaseSeconds: 60,
  breakerThreshold: 5,
  breakerCooldownSeconds: 30,
}

const claimedFor = (id: string): ClaimedDelivery => ({
  id,
  eventId: `event-${id}`,
  endpointId: 'endpoint-1',
  attemptNumber: 1,
  probe: false,
})

const detailsFor = (id: string): DeliveryDetails => ({
  deliveryId: id,
  attemptNumber: 1,
  eventId: `event-${id}`,
  eventType: 'demo.ping',
  payload: {},
  eventCreatedAt: new Date(0),
  endpointUrl: 'http://127.0.0.1:9/receive',
  secretCiphertext: Buffer.alloc(0),
  cycleStart: 1,
})

describe('createProcessDelivery record retries', () => {
  it('gives EVERY delivery the full record-retry budget (N1)', async () => {
    const sleep = vi.fn(async () => {})
    const { logger, warns, errors } = fakeLogger()
    const stats: DispatcherStats = {
      claims: 0,
      sends: 0,
      succeeded: 0,
      retried: 0,
      dead: 0,
      stale: 0,
    }
    const processDelivery = createProcessDelivery({
      pool: brokenPool(),
      config: CONFIG,
      logger,
      stats,
      isStopping: () => false,
      sleep,
      // 3 backoff entries → 3 warned retries, then the give-up error.
      recordBackoffMs: [1, 1, 1],
    })

    // Two deliveries hit the recording failure back to back. With a
    // process-wide backoff array the first delivery drains all three
    // waits and every later one gives up without a single retry.
    await processDelivery(claimedFor('delivery-1'), detailsFor('delivery-1'))
    expect(forDelivery(warns, 'delivery-1')).toBe(3)
    expect(forDelivery(errors, 'delivery-1')).toBe(1)

    await processDelivery(claimedFor('delivery-2'), detailsFor('delivery-2'))
    expect(forDelivery(warns, 'delivery-2')).toBe(3)
    expect(forDelivery(errors, 'delivery-2')).toBe(1)

    // Each retry waited exactly the injected backoff, in order.
    expect(sleep.mock.calls.flat()).toEqual([1, 1, 1, 1, 1, 1])

    // No record was ever applied: nothing counted as an outcome.
    expect(stats).toEqual({ claims: 0, sends: 2, succeeded: 0, retried: 0, dead: 0, stale: 0 })
  })
})
