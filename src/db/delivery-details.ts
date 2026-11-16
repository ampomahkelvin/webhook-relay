/**
 * The delivery details read model (DESIGN section 6.2): everything one
 * send needs, fetched just before the worker processes the delivery.
 */
import type { Pool } from 'pg'

export interface DeliveryDetails {
  deliveryId: string
  attemptNumber: number
  eventId: string
  eventType: string
  payload: unknown
  eventCreatedAt: Date
  endpointUrl: string
  secretCiphertext: Buffer
  /** `attempt_count` at the last (re)start; the schedule index is attemptNumber - cycleStart. */
  cycleStart: number
}

/**
 * Everything a send needs: the event (id, type, payload, creation) and the
 * endpoint's URL plus the encrypted signing secret, decrypted just in time
 * by the sender.
 */
export async function fetchDeliveryDetails(
  pool: Pool,
  ids: readonly string[],
): Promise<Map<string, DeliveryDetails>> {
  if (ids.length === 0) return new Map()
  const result = await pool.query<{
    id: string
    attempt_count: number
    cycle_start: number
    event_id: string
    event_type: string
    payload: unknown
    event_created_at: Date
    url: string
    secret_ciphertext: Buffer
  }>(
    `SELECT d.id, d.attempt_count, d.cycle_start, e.id AS event_id, e.event_type, e.payload,
            e.created_at AS event_created_at, ep.url, ep.secret_ciphertext
     FROM deliveries d
     JOIN events e ON e.id = d.event_id
     JOIN endpoints ep ON ep.id = d.endpoint_id
     WHERE d.id = ANY ($1::uuid[])`,
    [ids as unknown as string[]],
  )
  const map = new Map<string, DeliveryDetails>()
  for (const row of result.rows) {
    map.set(row.id, {
      deliveryId: row.id,
      attemptNumber: row.attempt_count,
      cycleStart: row.cycle_start,
      eventId: row.event_id,
      eventType: row.event_type,
      payload: row.payload,
      eventCreatedAt: row.event_created_at,
      endpointUrl: row.url,
      secretCiphertext: row.secret_ciphertext,
    })
  }
  return map
}
