import type { SendCallOptions } from './send.js'

/**
 * The dispatcher's shared contracts (`ports.ts`): the shape every
 * collaborator of the loop depends on, without importing concrete
 * implementations — the loop must not import the Metrics class, and the
 * per-delivery worker must not import the loop.
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
}

export interface DispatcherStats {
  claims: number
  sends: number
  succeeded: number
  retried: number
  dead: number
  stale: number
}

/**
 * The observability hooks the dispatcher needs (DESIGN section 11).
 * `observability/Metrics` satisfies this structurally, so callers can pass
 * the real thing — or nothing, or a test double — without this layer
 * importing it.
 */
export interface DispatcherMetrics {
  attemptDuration(seconds: number): void
  deliveryOutcome(outcome: 'succeeded' | 'retry' | 'dead'): void
}
