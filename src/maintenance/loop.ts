import type { Pool } from 'pg'
import { setTimeout as abortableSleep } from 'node:timers/promises'
import { runMaintenanceSweep, type SweepOptions, type SweepResult } from '../db/maintenance.js'

/**
 * The maintenance loop (scheduling only): sweep immediately (so a fresh
 * instance works at once), then every interval; the SQL lives in
 * `src/db/maintenance.ts`. Errors never kill the process — the next tick
 * retries — and each failure goes to `onError`.
 */

export interface MaintenanceLoopOptions extends SweepOptions {
  /** Sweep interval; every cycle re-competes for the advisory lock. */
  intervalMs: number
  /** Injectable stop signal. */
  shouldStop?: () => boolean
  /**
   * Abort signal for the between-sweeps sleep (I7): without it a stop
   * request waits out a full interval (up to a minute) before the loop
   * notices; with it the sleep wakes immediately.
   */
  signal?: AbortSignal
  onSweep?: (result: SweepResult) => void
  /** Called with every sweep failure so an entrypoint can log it. */
  onError?: (error: unknown) => void
}

/**
 * The maintenance loop for the entrypoint: sweep immediately (so a fresh
 * instance works at once), then every interval. Errors never kill the
 * process — the next tick retries — and each failure goes to `onError`.
 */
export async function runMaintenanceLoop(
  pool: Pool,
  options: MaintenanceLoopOptions,
): Promise<void> {
  const shouldStop = options.shouldStop ?? (() => false)
  const { signal } = options

  const sleep = async (ms: number): Promise<void> => {
    if (signal !== undefined) {
      try {
        await abortableSleep(ms, undefined, { signal })
      } catch {
        // Aborted: the stop check below ends the loop.
      }
      return
    }
    // No signal: slice the sleep so a shouldStop predicate is honored
    // within the slice, not after a whole interval.
    const sliceMs = Math.min(ms, 250)
    for (let waited = 0; waited < ms; waited += sliceMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, sliceMs))
      if (shouldStop()) return
    }
  }

  for (;;) {
    if (shouldStop() || signal?.aborted === true) return
    try {
      const result = await runMaintenanceSweep(pool, options)
      if (result.swept) {
        options.onSweep?.(result)
      }
    } catch (error) {
      options.onError?.(error)
    }
    await sleep(options.intervalMs)
  }
}
