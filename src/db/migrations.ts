import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Pool } from 'pg'
import type { Logger } from '../logger.js'

const MIGRATIONS_TABLE = 'schema_migrations'
export const DEFAULT_MIGRATIONS_DIR = 'migrations'

/**
 * Applies every not-yet-applied .sql file from `dir`, oldest first, in one
 * transaction. The migration SQL lives in this db module; the CLI that
 * drives it is `src/main/migrate.ts`.
 */
export async function applyMigrations(
  pool: Pool,
  dir: string = DEFAULT_MIGRATIONS_DIR,
  log?: Logger,
): Promise<string[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
         name       text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    )
    const existing = new Set(
      (
        await client
          .query<{ name: string }>(`SELECT name FROM ${MIGRATIONS_TABLE} FOR UPDATE`)
          .then((result) => result.rows)
      ).map((row) => row.name),
    )
    const applied: string[] = []
    for (const file of files) {
      if (existing.has(file)) continue
      const sql = await readFile(join(dir, file), 'utf8')
      await client.query(sql)
      await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES ($1)`, [file])
      applied.push(file)
      if (log) log.info({ migration: file }, 'applied migration')
    }
    await client.query('COMMIT')
    return applied
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
