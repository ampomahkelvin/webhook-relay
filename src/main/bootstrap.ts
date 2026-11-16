import type { Pool } from 'pg'
import { ConfigError } from '../config/schema.js'
import { createPool } from '../db/pool.js'
import { createLogger, type Logger } from '../logger.js'

/**
 * The ritual every entrypoint performs (api, dispatcher, maintenance): load
 * the process's validated config or exit 2, create the pool with the
 * idle-client error handler attached, and register the shutdown signals.
 * One helper so no entrypoint can forget a step — the api process used to
 * skip the pool error handler entirely, leaving uncaught idle-client
 * errors to kill it.
 */

/**
 * Load a process's config via its `load*Config` parser; on a ConfigError
 * print the reason and exit 2 ("config").
 */
export function loadConfigOrExit<T>(parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message)
      process.exit(2)
    }
    throw error
  }
}

/** Logger for the named process (used by createEntryPool). */
export function createProcessLogger(
  config: { logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' },
  name: string,
): Logger {
  return createLogger(name, config.logLevel)
}

/** Entry pool: a production pool plus the idle-client error handler. */
export function createEntryPool(
  config: { databaseUrl: string },
  logger: Logger,
  sizing?: { max: number },
): Pool {
  const pool = createPool(config.databaseUrl, sizing)
  pool.on('error', (error) => logger.error({ err: error }, 'idle client error'))
  return pool
}

/**
 * Run `handler` once, on the FIRST shutdown signal (SIGTERM or SIGINT) —
 * repeated signals must not restart the shutdown (N4): the second SIGTERM
 * used to run `shutdown()` again, and a second `server.close()` errors.
 * The process is already leaving; extra signals change nothing.
 */
export function installSignalHandlers(handler: (signal: 'SIGTERM' | 'SIGINT') => void): void {
  let shuttingDown = false
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (shuttingDown) return
      shuttingDown = true
      handler(signal)
    })
  }
}

/**
 * Arm the shutdown deadline (I7): graceful shutdown must not be able to
 * hang forever (a slow drain, a stuck close) — Docker sends SIGKILL after
 * its stop grace period anyway, so past this timer the process leaves
 * itself. Unref'd, so arming it never keeps a healthy process alive.
 * Clear the returned timer once cleanup has finished.
 *
 * Exit code 1 (N4): a shutdown that missed its deadline is a FAILED
 * shutdown — exiting 0 reported it as a clean one.
 */
export function armHardExit(logger: Logger, ms = 25_000): NodeJS.Timeout {
  const timer = setTimeout(() => {
    logger.error({ afterMs: ms }, 'graceful shutdown exceeded its deadline; exiting 1')
    process.exit(1)
  }, ms)
  timer.unref()
  return timer
}

/**
 * Top-level runner: any error escaping an entrypoint's `main` is printed
 * and exits 1, instead of dying as an unhandled rejection.
 */
export function runProcess(main: () => Promise<void>): void {
  void main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
