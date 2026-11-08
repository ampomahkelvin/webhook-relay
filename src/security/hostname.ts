/**
 * The hostname form every security layer agrees on: WHATWG URL keeps
 * brackets on IPv6 literals ('[::1]') and encodes zone ids as %25, while
 * the IP checks and DNS operate on the bare form (a zone id would make
 * resolution and range-checking see different addresses). Layer 1
 * (endpoint registration) and layer 2 (per-attempt resolution) both
 * normalize with this function rather than private copies — a mismatch
 * between them would let one layer see a blocked address the other
 * doesn't.
 */
export function normalizeUrlHostname(hostname: string): string {
  return (hostname.replace(/^\[/, '').replace(/\]$/, '').split('%')[0] ?? hostname).trim()
}
