import type { Pool } from 'pg'

/**
 * The cross-aggregate queue gauges (DESIGN section 11). The api process
 * renders these; the dispatcher never reads them, so this stays a read-only
 * module with no dispatcher imports.
 */

export interface QueueGauges {
  deliveriesPending: number
  oldestDueDeliveryAgeSeconds: number
  endpointsCircuitOpen: number
}

/**
 * One round trip over the partial indexes. `oldestDue` counts only
 * deliveries a worker could claim right now, minus the facts only the
 * dispatcher process knows: leased rows are excluded (data-derived), but
 * circuit/cooldown state is NOT folded in — the api process must not need
 * dispatcher configuration to render its gauges, so the gauge is an upper
 * bound on claimable backlog.
 */
export async function fetchQueueGauges(pool: Pool): Promise<QueueGauges> {
  const result = await pool.query<{
    pending: string
    oldest_due: string
    circuit_open: string
  }>(
    `SELECT
       (SELECT count(*) FROM deliveries WHERE status = 'pending')::text AS pending,
       (SELECT count(*) FROM endpoints WHERE circuit_state <> 'closed')::text AS circuit_open,
       COALESCE(
         (SELECT EXTRACT(EPOCH FROM now() - MIN(d.next_attempt_at))
          FROM deliveries d
          JOIN endpoints e ON e.id = d.endpoint_id
          WHERE d.status = 'pending' AND d.next_attempt_at <= now()
            AND d.locked_until IS NULL
            AND e.status = 'enabled'),
         0
       )::text AS oldest_due`,
  )
  const row = result.rows[0]!
  return {
    deliveriesPending: Number(row.pending),
    oldestDueDeliveryAgeSeconds: Math.floor(Number(row.oldest_due)),
    endpointsCircuitOpen: Number(row.circuit_open),
  }
}
