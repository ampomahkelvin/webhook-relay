import { isIP } from 'node:net'
import { isBlockedAddress } from './ip-blocklist.js'
import { normalizeUrlHostname } from './hostname.js'

export class InvalidEndpointUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidEndpointUrlError'
  }
}

export interface EndpointUrlOptions {
  /** Dev escape hatch: accept `http://` receivers. Default false. */
  allowInsecureHttp?: boolean
}

/**
 * Layer 1 of the SSRF defense (DESIGN section 8): fast feedback at
 * registration. The WHATWG parser normalizes tricks such as decimal or
 * octal IP literals before the blocklist check. This is a convenience,
 * NOT the defense — send-time validation (layer 2) re-checks everything,
 * including hostnames that resolve into blocked ranges.
 */
export function validateEndpointUrl(raw: string, options: EndpointUrlOptions = {}): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new InvalidEndpointUrlError('URL could not be parsed')
  }

  const isHttps = parsed.protocol === 'https:'
  const isHttp = parsed.protocol === 'http:'
  if (!isHttps && !(options.allowInsecureHttp === true && isHttp)) {
    throw new InvalidEndpointUrlError(`Only HTTPS URLs are allowed (got '${parsed.protocol}')`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new InvalidEndpointUrlError('URL must not contain embedded credentials')
  }

  const host = parsed.hostname
  // Node keeps brackets on IPv6 hostnames ('[::1]') and encodes zone ids as %25...
  const stripped = normalizeUrlHostname(host)
  if (isIP(stripped) !== 0) {
    if (isBlockedAddress(stripped)) {
      throw new InvalidEndpointUrlError(`Literal IP '${host}' is in a blocked range`)
    }
  }
  // Non-IP hostnames pass layer 1 on purpose: the check that matters
  // happens per attempt in layer 2, after DNS resolves (which is also
  // what defeats DNS rebinding).

  return parsed.toString()
}
