import { Pool } from 'pg'

export type { Pool } from 'pg'

/** Create the application's connection pool. Short claim/result transactions keep slots free. */
export function createPool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  })
}
