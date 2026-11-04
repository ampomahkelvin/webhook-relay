import type { Logger } from '../logger.js'
import type { Pool } from '../db/pool.js'
import {
  claimDueDeliveries,
  fetchDeliveryDetails,
  type ClaimedDelivery,
  type DeliveryDetails,
} from './claim.js'
import { recordAttempt, type SendOutcome } from './record.js'
import { sendDeliveryAttempt, type SendCallOptions } from './send.js'
import { scheduleNext } from '../domain/retry-schedule.js'
import type { Metrics } from '../observability/metrics.js'

/**
 * The dispatcher loop (DESIGN sections 6.1–6.4):
 *
 *  - claims at most `concurrency` deliveries; one short lease transaction
 *    per claim, never a transaction across a send;
 *  - after a FULL batch it claims again immediately — sleeping after every
 *    batch would cap throughput at batch size / poll interval (NFR5);
 *  - sleeps only when work ran out (empty or short batch, or no free slots);
 *  - records results with fencing: a stale worker's attempt log survives,
 *    its effect on the delivery does not;
 *  - graceful shutdown: stop claiming, finish in-flight sends (each is
 *    bounded by the request timeout), then resolve.
 *
 * The breaker application (consecutive-failure counters, half-open probe)
 * is Phase 6; this loop drives the delivery lifecycle only.
 */

export interface DispatcherConfig extends SendCallOptions {
  concurrency: number
  batchSize: number
  perEndpointClaimCap: number
  pollIntervalMs: number
  leaseSeconds: number
  breakerThreshold: number
  breakerCooldownSeconds: number
  /** Retry-schedule override for tests; defaults to the standard 7 delays. */
  delaysMs?: readonly number[]
  /** Injectable sleeper for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>
}

export interface DispatcherStats {
  claims: number
  sends: number
  succeeded: number
  retried: number
  dead: number
  stale: number
}

export interface Dispatcher {
  start: () => void
  /** Resolves once in-flight sends have finished (each bounded by the timeout). */
  stop: () => Promise<void>
  stats: () => DispatcherStats
  /** Current in-flight count; tests observe quiescence with it. */
  inFlightCount: () => number
}

type CapacityWaiter = () => void

export function createDispatcher(
  pool: Pool,
  config: DispatcherConfig,
  logger: Logger,
  /** Optional observability hooks (DESIGN section 11); runs fine without. */
  metrics?: Metrics,
): Dispatcher {
  const sleepFn = config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  let stopping = false
  let claimFailureLogged = false
  const stats: DispatcherStats = {
    claims: 0,
    sends: 0,
    succeeded: 0,
    retried: 0,
    dead: 0,
    stale: 0,
  }
  const inFlight = new Set<Promise<void>>()
  const capacityWaiters: CapacityWaiter[] = []

  let resolveStopSignal: () => void = () => {}
  const stopSignal = new Promise<void>((resolve) => {
    resolveStopSignal = resolve
  })

  const notifyCapacity = () => {
    for (const resolve of capacityWaiters.splice(0)) resolve()
  }

  async function idleWait(ms: number): Promise<void> {
    await Promise.race([stopSignal, sleepFn(ms)])
  }

  async function waitForCapacityOrStop(): Promise<void> {
    if (inFlight.size < config.concurrency) return
    await Promise.race([
      stopSignal,
      new Promise<void>((resolve) => {
        capacityWaiters.push(resolve)
      }),
    ])
  }

  const release = (promise: Promise<void>) => {
    inFlight.delete(promise)
    notifyCapacity()
  }

  interface RecordAttemptArgs {
    outcome: SendOutcome
    deadReason?: 'gone' | 'schedule_exhausted'
    nextAttemptAtMs?: number
  }

  /** All outcomes that touch the delivery (the fenced part). */
  async function decideOutcome(
    claimed: ClaimedDelivery,
    details: DeliveryDetails,
    sent: Awaited<ReturnType<typeof sendDeliveryAttempt>>,
  ): Promise<RecordAttemptArgs> {
    if (sent.outcome.kind === 'succeeded') {
      stats.succeeded++
      return { outcome: 'succeeded' as const }
    }
    if (sent.outcome.kind === 'gone') {
      stats.dead++
      return { outcome: 'dead' as const, deadReason: 'gone' as const }
    }
    const scheduled = scheduleNext({
      attemptNumber: claimed.attemptNumber - details.cycleStart,
      nowMs: Date.now(),
      retryAfterSeconds: sent.outcome.kind === 'retry' ? sent.outcome.retryAfterSeconds : undefined,
      delaysMs: config.delaysMs,
    })
    if (scheduled.outcome === 'dead') {
      stats.dead++
      return { outcome: 'dead' as const, deadReason: 'schedule_exhausted' as const }
    }
    stats.retried++
    return { outcome: 'retry' as const, nextAttemptAtMs: scheduled.nextAttemptAtMs }
  }

  async function processClaim(
    claimed: ClaimedDelivery,
    details: DeliveryDetails | undefined,
  ): Promise<void> {
    try {
      if (details === undefined) {
        // The delivery vanished under us (event or endpoint deleted —
        // cascade). Leave the lease to expire; nothing to record.
        stats.sends++
        return
      }
      const sent = await sendDeliveryAttempt(details, config)
      stats.sends++

      const decided = await decideOutcome(claimed, details, sent)
      const recorded = await recordAttempt(pool, {
        deliveryId: claimed.id,
        endpointId: claimed.endpointId,
        breakerThreshold: config.breakerThreshold,
        claimedAttempt: claimed.attemptNumber,
        startedAtMs: sent.startedAtMs,
        durationMs: sent.durationMs,
        statusCode: sent.statusCode,
        errorKind: sent.errorKind,
        responseSnippet: sent.snippet,
        ...decided,
      })
      if (!recorded.applied) {
        // Stale: the lease expired and a newer attempt exists. The attempt
        // log row stands; the delivery state belongs to the newer attempt.
        stats.stale++
        logger.info(
          { deliveryId: claimed.id, attempt: claimed.attemptNumber },
          'stale worker: result not applied',
        )
      } else if (metrics) {
        metrics.attemptDuration(sent.durationMs / 1_000)
        metrics.deliveryOutcome(decided.outcome)
      }
    } catch (error) {
      // An unexpected error must not take the dispatcher down; retry per
      // schedule via a best-effort fenced record.
      logger.error({ deliveryId: claimed.id, err: (error as Error).message }, 'worker error')
      try {
        const recorded = await recordAttempt(pool, {
          deliveryId: claimed.id,
          endpointId: claimed.endpointId,
          breakerThreshold: config.breakerThreshold,
          claimedAttempt: claimed.attemptNumber,
          outcome: 'retry',
          nextAttemptAtMs: Date.now() + config.pollIntervalMs,
          startedAtMs: Date.now(),
          durationMs: 0,
          errorKind: 'connection',
        })
        if (!recorded.applied) stats.stale++
      } catch {
        // Leave the lease: the delivery is retried after the lease expires.
      }
    }
  }

  async function scheduleClaimed(claimedList: ClaimedDelivery[]): Promise<void> {
    stats.claims += claimedList.length
    const details = await fetchDeliveryDetails(
      pool,
      claimedList.map((c) => c.id),
    )
    for (const claimed of claimedList) {
      const promise = processClaim(claimed, details.get(claimed.id)).finally(() => release(promise))
      inFlight.add(promise)
    }
  }

  async function pump(): Promise<void> {
    while (!stopping) {
      await waitForCapacityOrStop()
      if (stopping) break

      const wanted = Math.min(config.concurrency - inFlight.size, config.batchSize)
      let claimedList: ClaimedDelivery[]
      try {
        claimedList = await claimDueDeliveries(pool, {
          nowMs: Date.now(),
          batchSize: wanted,
          perEndpointClaimCap: config.perEndpointClaimCap,
          leaseSeconds: config.leaseSeconds,
          breakerCooldownSeconds: config.breakerCooldownSeconds,
        })
        claimFailureLogged = false
      } catch (error) {
        if (!claimFailureLogged) {
          logger.error({ err: (error as Error).message }, 'claim failed; backing off')
          claimFailureLogged = true
        }
        await idleWait(config.pollIntervalMs)
        continue
      }
      // stop() may have fired while the claim was in flight.
      if (stopping) break

      if (claimedList.length > 0) {
        await scheduleClaimed(claimedList)
        if (claimedList.length === wanted) continue // full batch: claim again immediately
      }
      // Work ran out: idle until the next poll.
      await idleWait(config.pollIntervalMs)
    }
    if (inFlight.size > 0) {
      logger.info({ inFlight: inFlight.size }, 'stopping: draining in-flight sends')
    }
  }

  return {
    start: () => {
      void pump().catch((error) => logger.error({ err: error }, 'dispatcher pump crashed'))
    },
    stop: async () => {
      if (stopping) return
      stopping = true
      resolveStopSignal()
      // A claim that was already in the air when stop() was called can add
      // sends after the first snapshot; keep draining until none remain.
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight])
      }
    },
    stats: () => ({ ...stats }),
    inFlightCount: () => inFlight.size,
  }
}
