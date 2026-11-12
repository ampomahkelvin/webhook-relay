/**
 * The dispatcher's concurrency gate (`concurrency-gate.ts`): tracks the
 * in-flight worker promises and decides when the pump may claim again.
 * Extracted from the loop so the "one send per delivery, bounded slots"
 * invariant (DESIGN section 6.1) is unit-testable without a database.
 */
export interface ConcurrencyGate {
  /** True when a worker could start right now. */
  hasCapacity(): boolean
  /**
   * Resolves when a slot frees up or the stop signal fires — the pump
   * re-checks `stopping` after this, so either resolution is safe.
   */
  waitCapacity(): Promise<void>
  /** Track a worker promise; its slot frees when it settles. */
  track(promise: Promise<void>): Promise<void>
  /** Current in-flight count; tests observe quiescence with it. */
  inFlightCount(): number
  /** Resolves once every tracked worker has settled (graceful drain). */
  drain(): Promise<void>
}

export function createConcurrencyGate(
  concurrency: number,
  stopSignal: Promise<void>,
): ConcurrencyGate {
  const inFlight = new Set<Promise<void>>()
  const capacityWaiters: (() => void)[] = []

  const notifyCapacity = () => {
    for (const resolve of capacityWaiters.splice(0)) resolve()
  }

  const release = (promise: Promise<void>) => {
    inFlight.delete(promise)
    notifyCapacity()
  }

  return {
    hasCapacity: () => inFlight.size < concurrency,

    waitCapacity: async () => {
      if (inFlight.size < concurrency) return
      await Promise.race([
        stopSignal,
        new Promise<void>((resolve) => {
          capacityWaiters.push(resolve)
        }),
      ])
    },

    track: (promise) => {
      const settled = promise.finally(() => release(settled))
      inFlight.add(settled)
      return settled
    },

    inFlightCount: () => inFlight.size,

    drain: async () => {
      // A claim that was already in the air when stop() was called can add
      // sends after the first snapshot; keep draining until none remain.
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight])
      }
    },
  }
}
