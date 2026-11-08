import type { Pool } from 'pg'
import { ConfigError, loadConfig, type Config } from '../config/index.js'
import { createPool } from '../db/pool.js'
import { createLogger, type Logger } from '../logger.js'

/**
 * The ritual every entrypoint performs (api, dispatcher, maintenance): load
 * the validated Config or exit 2, create the pool with the idle-client
 * error handler attached, and register the shutdown signals. One helper so
 * no entrypoint can forget a step — the api process used to skip the pool
 * error handler entirely, leaving uncaught idle-client errors to kill it.
 */

/** Load config; on a ConfigError print the reason and exit 2 ("config"). */
export function loadConfigOrExit(): Config {
  try {
    return loadConfig()
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message)
      process.exit(2)
    }
    throw error
  }
}

/** Logger for the named process (used by createEntryPool). */
export function createProcessLogger(config: Config, name: string): Logger {
  return createLogger(name, config.logLevel)
}

/** Entry pool: a production pool plus the idle-client error handler. */
export function createEntryPool(
  config: Pick<Config, 'databaseUrl'>,
  logger: Logger,
  sizing?: { max: number },
): Pool {
  const pool = createPool(config.databaseUrl, sizing)
  pool.on('error', (error) => logger.error({ err: error }, 'idle client error'))
  return pool
}

/** Run `handler` once per received shutdown signal (SIGTERM / SIGINT). */
export function installSignalHandlers(handler: (signal: 'SIGTERM' | 'SIGINT') => void): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => handler(signal))
  }
}
