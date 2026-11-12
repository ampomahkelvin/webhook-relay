import { pathToFileURL } from 'node:url'
import { loadProcessConfig } from '../config/schema.js'
import { createLogger } from '../logger.js'
import { createPool } from '../db/pool.js'
import { applyMigrations, DEFAULT_MIGRATIONS_DIR } from '../db/migrations.js'

/**
 * The `migrate` CLI entrypoint (`npm run migrate` / its own compose
 * service): apply the SQL migrations, then exit.
 */
export async function runAsCli(): Promise<void> {
  const config = loadProcessConfig()
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
