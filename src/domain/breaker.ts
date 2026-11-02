/**
 * Circuit-breaker transitions (DESIGN section 7), pure and clock-injected.
 * State lives on `endpoints` — it belongs to the receiver, not to any one
 * delivery.
 *
 * The write-amplification rule lives here too: a success on an already
 * healthy endpoint (`closed`, zero failures) requires NO endpoint-row
 * write, so a busy healthy receiver never becomes a hot row. Only
 * failures and recoveries update it.
 */

export type CircuitState = 'closed' | 'open' | 'half_open'

/** The breaker state as stored on the endpoint row. */
export interface BreakerSnapshot {
  circuit: CircuitState
  consecutiveFailures: number
  /**
   * When the circuit entered its CURRENT non-closed state — both the
   * cooldown timer for `open` and the re-probe timer for `half_open`.
   * `null` only while closed.
   */
  openedAtMs: number | null
}

export interface BreakerTransition {
  next: BreakerSnapshot
  /**
   * False exactly when the snapshot is unchanged (healthy success): the
   * caller skips the endpoint write entirely.
   */
  write: boolean
}

/** A healthy endpoint snapshot to derive from when the row is read. */
export const CLOSED_BREAKER: BreakerSnapshot = {
  circuit: 'closed',
  consecutiveFailures: 0,
  openedAtMs: null,
}

/**
 * A recorded failure. `consecutiveFailures` counts attempts that did not
 * succeed; reaching the threshold opens the breaker and starts (or keeps)
 * the cooldown clock — `openedAtMs` is the moment the circuit left
 * `closed`, and is refreshed whenever a failing probe reopens.
 */
export function nextOnFailure(
  snapshot: BreakerSnapshot,
  nowMs: number,
  threshold: number,
): BreakerTransition {
  const failedCount = snapshot.consecutiveFailures + 1
  if (snapshot.circuit === 'closed' && failedCount < threshold) {
    return {
      next: {
        circuit: 'closed',
        consecutiveFailures: failedCount,
        openedAtMs: snapshot.openedAtMs,
      },
      write: true,
    }
  }
  if (snapshot.circuit === 'open') {
    // A failure can only reach an open breaker from a stale writer that
    // the fencing layer should have stopped; treat it defensively as
    // "still open, cooldown unchanged".
    return {
      next: { ...snapshot, consecutiveFailures: failedCount },
      write: true,
    }
  }
  // Entering open from closed, or a probe failing (half_open → open):
  // both start a fresh cooldown.
  return {
    next: { circuit: 'open', consecutiveFailures: failedCount, openedAtMs: nowMs },
    write: true,
  }
}

/**
 * A recorded success. Healthy-and-silent (closed, zero failures) skips the
 * write — the one line where the write-amplification rule bites.
 */
export function nextOnSuccess(snapshot: BreakerSnapshot): BreakerTransition {
  if (snapshot.circuit === 'closed' && snapshot.consecutiveFailures === 0) {
    return { next: { ...snapshot }, write: false }
  }
  return {
    next: { circuit: 'closed', consecutiveFailures: 0, openedAtMs: null },
    write: true,
  }
}
