import { describe, expect, it } from 'vitest'
import { InvalidEndpointUrlError, validateEndpointUrl } from '../../src/domain/endpoint-url.js'

describe('validateEndpointUrl (layer 1)', () => {
  it('accepts normal HTTPS URLs', () => {
    expect(validateEndpointUrl('https://example.com/hook')).toBe('https://example.com/hook')
    expect(validateEndpointUrl('https://api.example.com:8443/webhooks')).toBe(
      'https://api.example.com:8443/webhooks',
    )
  })

  it('rejects non-HTTPS schemes', () => {
    expect(() => validateEndpointUrl('ftp://example.com/hook')).toThrow(/Only HTTPS/)
    expect(() => validateEndpointUrl('file:///etc/passwd')).toThrow(/Only HTTPS/)
    expect(() => validateEndpointUrl('http://example.com/hook')).toThrow(/Only HTTPS/)
  })

  it('allows plain HTTP only behind the dev flag', () => {
    expect(validateEndpointUrl('http://receiver:3000/hook', { allowInsecureHttp: true })).toBe(
      'http://receiver:3000/hook',
    )
    expect(() => validateEndpointUrl('http://receiver:3000/hook')).toThrow(/Only HTTPS/)
  })

  it('rejects unparseable URLs', () => {
    expect(() => validateEndpointUrl('not a url')).toThrow(/could not be parsed/)
    expect(() => validateEndpointUrl('')).toThrow(/could not be parsed/)
  })

  it('rejects embedded credentials', () => {
    expect(() => validateEndpointUrl('https://user:pass@example.com/hook')).toThrow(
      /must not contain embedded credentials/,
    )
    expect(() => validateEndpointUrl('https://user@example.com/hook')).toThrow(
      /must not contain embedded credentials/,
    )
  })

  it('rejects blocked literal IPs', () => {
    expect(() => validateEndpointUrl('https://127.0.0.1/hook')).toThrow(/blocked range/)
    expect(() => validateEndpointUrl('https://[::1]/hook')).toThrow(/blocked range/)
    expect(() => validateEndpointUrl('https://169.254.169.254/latest')).toThrow(/blocked range/)
    expect(() => validateEndpointUrl('https://10.0.0.5/hook')).toThrow(/blocked range/)
    expect(() => validateEndpointUrl('https://192.168.1.4/hook')).toThrow(/blocked range/)
  })

  it('blocked literal IPs fail with a machine-readable blocked_address code', () => {
    try {
      validateEndpointUrl('https://10.0.0.5/hook')
      expect.unreachable('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidEndpointUrlError)
      expect((error as InvalidEndpointUrlError).code).toBe('blocked_address')
    }
    try {
      validateEndpointUrl('https://user:pass@example.com/hook')
      expect.unreachable('expected a throw')
    } catch (error) {
      expect((error as InvalidEndpointUrlError).code).toBe('invalid_url')
    }
  })

  it('allowPrivateTargets honors the dev flag for literal IPs (layer 2 still enforces per attempt)', () => {
    expect(validateEndpointUrl('https://10.0.0.5/hook', { allowPrivateTargets: true })).toBe(
      'https://10.0.0.5/hook',
    )
    expect(validateEndpointUrl('https://[::1]/hook', { allowPrivateTargets: true })).toBe(
      'https://[::1]/hook',
    )
    // The rest of the policy is NOT relaxed by the flag.
    expect(() =>
      validateEndpointUrl('https://user:pass@example.com/hook', { allowPrivateTargets: true }),
    ).toThrow(InvalidEndpointUrlError)
  })

  it('rejects WHATWG-normalized IP tricks', () => {
    // Decimal literal for 127.0.0.1
    expect(() => validateEndpointUrl('https://2130706433/latest')).toThrow(/blocked range/)
    // Hex form
    expect(() => validateEndpointUrl('https://0x7f.0.0.1/latest')).toThrow(/blocked range/)
    // Octal form
    expect(() => validateEndpointUrl('https://0177.0.0.1/latest')).toThrow(/blocked range/)
    // Mixed (5 octets): the WHATWG parser itself rejects it — either way, no pass
    expect(() => validateEndpointUrl('https://0x7f.0.0.2130706433.1/latest')).toThrow()
  })

  it('allows public literal IPs', () => {
    expect(validateEndpointUrl('https://1.1.1.1/latest')).toBe('https://1.1.1.1/latest')
  })

  it('passes public-local hostnames through (layer 2 decides)', () => {
    // A hostname that might resolve into a blocked range is allowed here:
    // the real defense re-resolves per attempt at send time.
    expect(validateEndpointUrl('https://internal.corp.example/hook')).toBe(
      'https://internal.corp.example/hook',
    )
  })

  it('normalizes the URL it returns', () => {
    expect(validateEndpointUrl('HTTPS://EXAMPLE.COM/HOOK')).toBe('https://example.com/HOOK')
  })
})
