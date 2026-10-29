import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Pool } from 'pg'
import type { Logger } from '../logger.js'
import { loadConfig } from '../config/index.js'
import { createLogger } from '../logger.js'
import { createPool } from './pool.js'

const MIGRATIONS_TABLE = 'schema_migrations'
const DEFAULT_MIGRATIONS_DIR = 'migrations'

/** Applies every not-yet-applied .sql file from `dir`, oldest first, in one transaction. */
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

/** CLI entry: `npm run migrate`. */
export async function runAsCli(): Promise<void> {
  const config = loadConfig()
  const log = createLogger('migrate', config.logLevel)
  const pool = createPool(config.databaseUrl)
  try {
    const applied = await applyMigrations(pool, DEFAULT_MIGRATIONS_DIR, log)
    log.info({ applied: applied.length }, 'migrations up to date')
  } finally {
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAsCli().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
