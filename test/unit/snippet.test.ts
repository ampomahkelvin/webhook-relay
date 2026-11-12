import { describe, expect, it } from 'vitest'
import { toSnippet } from '../../src/dispatcher/send.js'

/**
 * The snippet sanitizer is the C1 regression guard: Postgres `text`
 * rejects invalid UTF-8 and NUL bytes, so whatever a receiver answers
 * must become a storage-safe string at the boundary — never a thrown
 * insert, which (before the fix) re-sent deliveries every poll interval.
 */
describe('toSnippet', () => {
  it('passes plain ASCII through unchanged', () => {
    expect(toSnippet(Buffer.from('{"received":true}'))).toBe('{"received":true}')
  })

  it('decodes a cut multi-byte character as U+FFFD instead of throwing', () => {
    // '€' is 3 bytes (E2 82 AC); 400 of them are 1200 bytes. 1024 = 341×3+1,
    // so the cut lands inside the 342nd character — exactly the
    // invalid-UTF-8 case that used to throw the insert.
    const body = Buffer.from('€'.repeat(400), 'utf8')
    expect(body.length).toBe(1200)
    const snippet = toSnippet(body)
    expect(snippet.length).toBe(342) // 341 complete characters + 1 replacement
    expect(snippet).toContain('€')
    expect(snippet.endsWith('\uFFFD')).toBe(true)
  })

  it('replaces NUL bytes (Postgres text cannot store them)', () => {
    expect(toSnippet(Buffer.from([0x7b, 0x00, 0x7d]))).toBe('{\uFFFD}')
  })

  it('decodes non-UTF-8 bytes (Latin-1 / gzip) as replacement characters', () => {
    // 0x1f and 0x08 are valid ASCII; 0x8b and a lone 0xc3 are not; NUL is
    // replaced too.
    expect(toSnippet(Buffer.from([0x1f, 0x8b, 0x08, 0x00]))).toBe('\u001f\uFFFD\b\uFFFD')
    expect(toSnippet(Buffer.from([0x8b, 0xc3]))).toBe('\uFFFD\uFFFD')
  })

  it('caps at maxBytes bytes before decoding', () => {
    expect(toSnippet(Buffer.alloc(2000, 'x'))).toHaveLength(1024)
    expect(toSnippet(Buffer.alloc(10, 'y'), 5)).toBe('yyyyy')
  })

  it('an empty body is an empty string, not undefined', () => {
    expect(toSnippet(Buffer.alloc(0))).toBe('')
  })
})
