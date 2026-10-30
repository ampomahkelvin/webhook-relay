import { describe, expect, it } from 'vitest'
import {
  classifyAttempt,
  parseRetryAfter,
  RETRY_AFTER_CAP_SECONDS,
} from '../../src/domain/classify.js'

/** Every row is a DESIGN section 6.3 classification-table entry. */
describe('classifyAttempt', () => {
  it('succeeds on any 2xx', () => {
    expect(classifyAttempt({ statusCode: 200 })).toEqual({ kind: 'succeeded' })
    expect(classifyAttempt({ statusCode: 201 })).toEqual({ kind: 'succeeded' })
    expect(classifyAttempt({ statusCode: 204 })).toEqual({ kind: 'succeeded' })
    expect(classifyAttempt({ statusCode: 299 })).toEqual({ kind: 'succeeded' })
  })

  it('dies on 410 Gone', () => {
    expect(classifyAttempt({ statusCode: 410 })).toEqual({ kind: 'gone' })
  })

  it('honors Retry-After on 429 and 503', () => {
    expect(classifyAttempt({ statusCode: 429, headers: { 'retry-after': '120' } })).toEqual({
      kind: 'retry',
      errorKind: 'http_status',
      retryAfterSeconds: 120,
    })
    expect(classifyAttempt({ statusCode: 503, headers: { 'retry-after': '3' } })).toEqual({
      kind: 'retry',
      errorKind: 'http_status',
      retryAfterSeconds: 3,
    })
    expect(
      classifyAttempt({ statusCode: 429, headers: { 'retry-after': [' 45 ', 'ignored'] } }),
    ).toMatchObject({ retryAfterSeconds: 45 })
  })

  it('caps Retry-After at one hour', () => {
    const capped = classifyAttempt({
      statusCode: 429,
      headers: { 'retry-after': String(RETRY_AFTER_CAP_SECONDS * 10) },
    })
    expect(capped).toMatchObject({ retryAfterSeconds: RETRY_AFTER_CAP_SECONDS })
  })

  it('falls back to the schedule when Retry-After is absent or unparseable', () => {
    expect(classifyAttempt({ statusCode: 429 })).toEqual({
      kind: 'retry',
      errorKind: 'http_status',
    })
    expect(classifyAttempt({ statusCode: 503, headers: { 'retry-after': 'soon' } })).toEqual({
      kind: 'retry',
      errorKind: 'http_status',
    })
  })

  it('parses HTTP-date Retry-After against the injected clock', () => {
    const now = 1_700_000_000
    const result = parseRetryAfter(new Date((now + 300) * 1000).toUTCString(), now)
    expect(result).toBe(300)
  })

  it('never follows redirects', () => {
    expect(classifyAttempt({ statusCode: 302 })).toEqual({
      kind: 'retry',
      errorKind: 'redirect',
    })
    expect(classifyAttempt({ statusCode: 301, headers: { location: 'http://10.0.0.1/' } })).toEqual(
      {
        kind: 'retry',
        errorKind: 'redirect',
      },
    )
    expect(classifyAttempt({ statusCode: 308 })).toEqual({
      kind: 'retry',
      errorKind: 'redirect',
    })
  })

  it('retries other 4xx and 5xx per the schedule', () => {
    const outcome = classifyAttempt({ statusCode: 404 })
    expect(outcome).toEqual({ kind: 'retry', errorKind: 'http_status' })
    expect(classifyAttempt({ statusCode: 500 })).toEqual({
      kind: 'retry',
      errorKind: 'http_status',
    })
    expect(classifyAttempt({ statusCode: 418 })).toEqual({
      kind: 'retry',
      errorKind: 'http_status',
    })
    expect(classifyAttempt({ statusCode: 599 })).toEqual({
      kind: 'retry',
      errorKind: 'http_status',
    })
    // A Retry-After must never arrive on a plain 500.
    expect(outcome).not.toHaveProperty('retryAfterSeconds')
  })

  it('fails the attempt on transport errors even when headers arrived', () => {
    expect(
      classifyAttempt({ statusCode: 200, errorKind: 'connection' }), // response dropped mid-body
    ).toEqual({ kind: 'retry', errorKind: 'connection' })
  })

  it('passthrough transport error kinds', () => {
    for (const errorKind of ['timeout', 'connection', 'dns', 'tls', 'blocked_address'] as const) {
      expect(classifyAttempt({ errorKind })).toEqual({ kind: 'retry', errorKind })
    }
  })

  it('needs a status code or an error kind', () => {
    expect(() => classifyAttempt({})).toThrow()
  })
})
