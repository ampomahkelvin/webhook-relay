import type { Pool } from 'pg'

/** The breaker columns of one endpoint row, as the tests assert them. */
export interface EndpointState {
  circuit_state: string
  consecutive_failures: number
  failing_since: Date | null
  circuit_opened_at: Date | null
  status: string
  disabled_reason: string | null
}

export async function endpointState(pool: Pool, endpointId: string): Promise<EndpointState> {
  const result = await pool.query<EndpointState>(
    `SELECT circuit_state::text, consecutive_failures, failing_since, circuit_opened_at,
            status::text, disabled_reason
     FROM endpoints WHERE id = $1`,
    [endpointId],
  )
  return result.rows[0]!
}
