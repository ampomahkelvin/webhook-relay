/**
 * Attempt-result classifier (DESIGN section 6.3). Pure: turns "what did the
 * wire give us" into "what happens to this delivery next". The retry
 * schedule, jitter, and the dead cutoff are the dispatcher's side (Phase 5);
 * this file only decides the outcome.
 */

export const RETRY_AFTER_CAP_SECONDS = 3600

export type ErrorKind =
  'timeout' | 'connection' | 'dns' | 'tls' | 'blocked_address' | 'redirect' | 'http_status'

/** Headers as Node delivers them: lowercased keys, values vary by count. */
export type HttpLikeHeaders = Record<string, string | string[] | number | undefined>

export type AttemptOutcome =
  | { kind: 'succeeded' }
  /** Delivery dead and the endpoint is disabled with reason `gone`. */
  | { kind: 'gone' }
  | { kind: 'retry'; errorKind: ErrorKind; retryAfterSeconds?: number }

export interface AttemptResult {
  /** HTTP status of the response; undefined when no response arrived. */
  statusCode?: number
  /** Transport-level error kind; overrides a partial status when present. */
  errorKind?: ErrorKind
  headers?: HttpLikeHeaders
  /** Injected clock for HTTP-date `Retry-After` values; unix seconds. */
  nowSeconds?: number
}

export function classifyAttempt(result: AttemptResult): AttemptOutcome {
  // A transport error means the response (if any) is incomplete: fails the
  // attempt even if headers arrived. The DNS answer may change, so a
  // blocked_address result also retries rather than dying immediately.
  if (result.errorKind !== undefined) {
    return { kind: 'retry', errorKind: result.errorKind }
  }
  const { statusCode } = result
  if (statusCode === undefined) {
    throw new Error('classifyAttempt needs a status code or an error kind')
  }
  if (statusCode >= 200 && statusCode < 300) return { kind: 'succeeded' }
  if (statusCode === 410) return { kind: 'gone' }
  if (statusCode >= 300 && statusCode < 400) {
    return { kind: 'retry', errorKind: 'redirect' }
  }
  if (statusCode === 429 || statusCode === 503) {
    const retryAfterSeconds = parseRetryAfter(result.headers?.['retry-after'], result.nowSeconds)
    const outcome: AttemptOutcome = { kind: 'retry', errorKind: 'http_status' }
    if (retryAfterSeconds !== undefined) {
      return { ...outcome, retryAfterSeconds: Math.min(retryAfterSeconds, RETRY_AFTER_CAP_SECONDS) }
    }
    return outcome
  }
  // Any other 4xx or 5xx (and anything unexpected): retry per schedule.
  return { kind: 'retry', errorKind: 'http_status' }
}

/**
 * `Retry-After` may be seconds or an HTTP date. An unparseable value is
 * ignored — the retry then uses the regular schedule, which the header can
 * only postpone, never shorten (DESIGN section 6.3).
 */
export function parseRetryAfter(
  header: string | string[] | number | undefined,
  nowSeconds?: number,
): number | undefined {
  if (header === undefined) return undefined
  const raw = (Array.isArray(header) ? header[0] : header) ?? ''
  const text = typeof raw === 'number' ? String(raw) : raw.trim()
  if (/^\d+$/.test(text)) return Number(text)
  const dateMs = Date.parse(text)
  if (Number.isNaN(dateMs)) return undefined
  const nowS = nowSeconds ?? Math.floor(Date.now() / 1000)
  return Math.max(0, Math.ceil(dateMs / 1000 - nowS))
}
