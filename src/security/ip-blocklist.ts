import { isIP } from 'node:net'

/**
 * Pure endpoint-IP classifier (DESIGN section 8 table). No I/O: takes an
 * address string, answers "would connecting here be allowed?".
 * Callers only pass addresses from the WHATWG parser (hostname, literal IPs,
 * normalized decimal/octal) or from DNS answers, so unparseable input is a
 * programming error and throws.
 */

export function isBlockedAddress(address: string): boolean {
  const plain = stripZone(address)
  const kind = isIP(plain)
  if (kind === 4) return isBlockedIpv4(plain)
  if (kind === 6) {
    const value = parseIpv6(plain)
    if (value === null) throw new Error(`unparseable IPv6 address: ${plain}`)
    const unwrapped = unwrapEmbeddedIpv4(value)
    if (unwrapped !== null) return isBlockedIpv4(unwrapped)
    return isBlockedIpv6(value)
  }
  throw new Error(`not an IP address: ${address}`)
}

/** Removes an IPv6 zone id (`fe80::1%25eth0` → `fe80::1`). */
function stripZone(address: string): string {
  const percent = address.indexOf('%')
  return percent === -1 ? address : address.slice(0, percent)
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  const a = parts[0] as number
  const b = parts[1] as number
  const c = parts[2] as number
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`unparseable IPv4 address: ${ip}`)
  }
  if (a === 0) return true // 0.0.0.0/8
  if (a === 10) return true // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true // 127.0.0.0/8
  if (a === 169 && b === 254) return true // 169.254.0.0/16 (link-local, cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true // 192.0.0.0/24
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18.0.0/15 (benchmarking)
  if (a >= 224 && a <= 239) return true // 224.0.0.0/4 (multicast)
  if (a >= 240) return true // 240.0.0.0/4 (reserved, incl. 255.255.255.255)
  return false
}

function isBlockedIpv6(value: bigint): boolean {
  if (value === 0n) return true // ::
  if (value === 1n) return true // ::1
  // fc00::/7 = 1111110x...: the top 7 bits are exactly 0b1111110 (0x7e)
  // for both fc and fd octets.
  if (value >> (128n - 7n) === 0x7en) return true // fc00::/7 (incl. fd00::/8)
  // fe80::/10 = 1111111010xxxxxxxxxxxx: the top 10 bits are exactly
  // 0b1111111010 (0x3fa); fec0/dfc address space is NOT covered.
  if (value >> (128n - 10n) === 0x3fan) return true // fe80::/10
  if (value >> (128n - 8n) === 0xffn) return true // ff00::/8
  return false
}

/**
 * IPv4-mapped (`::ffff:0:0/96`) and NAT64 (`64:ff9b::/96`) addresses are
 * unwrapped to dotted IPv4 so their v4 ranges are applied (DESIGN section 8).
 */
function unwrapEmbeddedIpv4(value: bigint): string | null {
  // mapped: groups 0..4 are 0 and group 5 is 0xffff → upper 96 bits = 0xffff
  const isMapped = value >> 32n === 0xffffn
  const isNat64 = value >> 96n === 0x64ff9bn
  if (!isMapped && !isNat64) return null
  const low32 = value & 0xffffffffn
  const bytes = [
    (low32 >> 24n) & 0xffn,
    (low32 >> 16n) & 0xffn,
    (low32 >> 8n) & 0xffn,
    low32 & 0xffn,
  ].map(Number)
  return bytes.join('.')
}

/** Parse an IPv6 address into its 128-bit number, or null when invalid. */
function parseIpv6(ip: string): bigint | null {
  if (ip.length < 2 || (ip.at(-1) === ':' && !ip.endsWith('::'))) return null

  // The final group may be an embedded dotted quad (always the last 32 bits).
  let body = ip
  let embedded: bigint | null = null
  const lastColon = ip.lastIndexOf(':')
  const tail = ip.slice(lastColon + 1)
  if (tail.includes('.')) {
    if (lastColon < 0) return null
    const quad = dottedQuadToBigInt(tail)
    if (quad === null) return null
    embedded = quad
    body = ip.slice(0, lastColon + 1)
  }

  let left: string[]
  let right: string[]
  let compressed = false
  if (body.includes('::')) {
    if (body.includes(':::')) return null
    const parts = body.split('::') as [string, string]
    // With an embedded quad the body ends in ': '::ffff:' — drop it.
    let rightSide = parts[1] ?? ''
    if (rightSide.endsWith(':')) rightSide = rightSide.slice(0, -1)
    left = parts[0] === '' ? [] : parts[0].split(':')
    right = rightSide === '' ? [] : rightSide.split(':')
    compressed = true
  } else if (body.endsWith(':')) {
    return null // single trailing colon, not '::'
  } else {
    left = body.split(':')
    right = []
  }

  const values: bigint[] = []
  const rightValues: bigint[] = []
  for (const seg of left) {
    const v = hexGroup(seg)
    if (v === null) return null
    values.push(BigInt(v))
  }
  for (const seg of right) {
    const v = hexGroup(seg)
    if (v === null) return null
    rightValues.push(BigInt(v))
  }

  const fixedCount = values.length + rightValues.length + (embedded === null ? 0 : 2)
  if (compressed) {
    const zeros = 8 - fixedCount
    if (zeros < 1) return null // '::' must replace at least one group
    for (let i = 0; i < zeros; i++) values.push(0n)
  } else if (fixedCount !== 8) {
    return null
  }

  if (embedded !== null) {
    // The quad occupies the final 32 bits, high 16 bits first.
    rightValues.push((embedded >> 16n) & 0xffffn, embedded & 0xffffn)
  }

  let value = 0n
  let count = 0
  for (const v of [...values, ...rightValues]) {
    value = (value << 16n) | v
    count++
  }
  return count === 8 ? value : null
}

function hexGroup(seg: string): number | null {
  if (!/^[0-9a-fA-F]{1,4}$/.test(seg)) return null
  return parseInt(seg, 16)
}

function dottedQuadToBigInt(tail: string): bigint | null {
  const parts = tail.split('.')
  if (parts.length !== 4) return null
  if (!parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null
  return (
    (BigInt(parts[0] as string) << 24n) +
    (BigInt(parts[1] as string) << 16n) +
    (BigInt(parts[2] as string) << 8n) +
    BigInt(parts[3] as string)
  )
}
