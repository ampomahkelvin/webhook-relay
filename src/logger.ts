import { pino } from 'pino'

export type Logger = ReturnType<typeof pino>

/**
 * Create a service-scoped structured logger.
 * Logs are JSON on stdout; never log secrets, API keys, or payloads.
 */
export function createLogger(service: string, level = 'info'): Logger {
  return pino({ level, base: { service } })
}
