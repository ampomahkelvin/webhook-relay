import { Pool } from 'pg'

export type { Pool } from 'pg'

/**
 * Create the application's connection pool. Short claim/result
 * transactions keep slots free.
 *
 * `max` defaults to 10 (enough for the api process). Concurrent processes
 * must size it to their own parallelism: the dispatcher, which drives one
 * send per in-flight delivery, passes `dispatcherConcurrency + margin` —
 * a pool smaller than the concurrency starves workers and hides as
 * mysterious latency.
 */
export function createPool(databaseUrl: string, sizing: { max?: number } = {}): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: sizing.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  })
}
