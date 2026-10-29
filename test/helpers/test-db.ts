import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { Pool } from 'pg'
import { applyMigrations } from '../../src/db/migrate.js'
import { createPool } from '../../src/db/pool.js'
import { join } from 'node:path'

export interface TestDatabase {
  pool: Pool
  container: StartedPostgreSqlContainer
  stop: () => Promise<void>
}

/**
 * Start a fresh Postgres, apply all migrations, and hand back a pool.
 * Call it once per test file (beforeAll) and stop it in afterAll, so every
 * test file runs against a clean database.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start()
  const pool = createPool(container.getConnectionUri())
  await applyMigrations(pool, join(process.cwd(), 'migrations'))

  const stop = async () => {
    await pool.end()
    await container.stop()
  }
  return { pool, container, stop }
}
