import type { Logger } from '../logger.js'
import type { Pool } from '../db/pool.js'
import {
  claimDueDeliveries,
  fetchDeliveryDetails,
  type ClaimedDelivery,
} from '../db/delivery-queue.js'
import { createConcurrencyGate } from './concurrency-gate.js'
import { createProcessDelivery } from './process-delivery.js'
import type { DispatcherConfig, DispatcherMetrics, DispatcherStats } from './ports.js'

export type { DispatcherConfig, DispatcherStats } from './ports.js'

/**
 * The dispatcher loop (DESIGN sections 6.1–6.4). This file drives the
 * delivery lifecycle only; its collaborators own the rules:
 *
 *  - claiming and recording are the statements in `db/delivery-queue.ts`,
 *    the breaker transitions in `domain/breaker.ts`;
 *  - send + decide + record for ONE delivery is `process-delivery.ts`;
 *  - the outcome decision is the pure `decide-outcome.ts`;
 *  - in-flight bookkeeping and slot waiting is `concurrency-gate.ts`.
 *
 * Loop behavior:
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
 */

export interface Dispatcher {
  start: () => void
  /** Resolves once in-flight sends have finished (each bounded by the timeout). */
  stop: () => Promise<void>
  stats: () => DispatcherStats
  /** Current in-flight count; tests observe quiescence with it. */
  inFlightCount: () => number
}

export function createDispatcher(
  pool: Pool,
  config: DispatcherConfig,
  logger: Logger,
  /** Optional observability hooks (DESIGN section 11); runs fine without. */
  metrics?: DispatcherMetrics,
): Dispatcher {
  const sleepFn = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

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

  let resolveStopSignal: () => void = () => {}
  const stopSignal = new Promise<void>((resolve) => {
    resolveStopSignal = resolve
  })

  async function idleWait(ms: number): Promise<void> {
    await Promise.race([stopSignal, sleepFn(ms)])
  }

  const gate = createConcurrencyGate(config.concurrency, stopSignal)

  const processDelivery = createProcessDelivery({
    pool,
    config,
    logger,
    stats,
    isStopping: () => stopping,
    sleep: idleWait,
    metrics,
  })

  async function scheduleClaimed(claimedList: ClaimedDelivery[]): Promise<void> {
    stats.claims += claimedList.length
    const details = await fetchDeliveryDetails(
      pool,
      claimedList.map((c) => c.id),
    )
    for (const claimed of claimedList) {
      gate.track(processDelivery(claimed, details.get(claimed.id)))
    }
  }

  async function pump(): Promise<void> {
    while (!stopping) {
      await gate.waitCapacity()
      if (stopping) break

      const wanted = Math.min(config.concurrency - gate.inFlightCount(), config.batchSize)
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
        try {
          await scheduleClaimed(claimedList)
        } catch (error) {
          // A details-read failure must not kill the pump (it would end
          // dispatching silently): back off like a failed claim. These
          // claims' leases expire on their own and are then re-claimed.
          if (!claimFailureLogged) {
            logger.error({ err: (error as Error).message }, 'details read failed; backing off')
            claimFailureLogged = true
          }
          await idleWait(config.pollIntervalMs)
          continue
        }
        if (claimedList.length === wanted) continue // full batch: claim again immediately
      }
      // Work ran out: idle until the next poll.
      await idleWait(config.pollIntervalMs)
    }
    if (gate.inFlightCount() > 0) {
      logger.info({ inFlight: gate.inFlightCount() }, 'stopping: draining in-flight sends')
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
      await gate.drain()
    },
    stats: () => ({ ...stats }),
    inFlightCount: () => gate.inFlightCount(),
  }
}
