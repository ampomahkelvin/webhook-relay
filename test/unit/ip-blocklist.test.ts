import { describe, expect, it } from 'vitest'
import { isBlockedAddress } from '../../src/security/ip-blocklist.js'

const FREE = 'not blocked'
const BLOCK = 'blocked'

// Every range from DESIGN section 8, both edges.
const CASES: Array<[string, 'blocked' | 'not blocked' | 'throws', string?]> = [
  // --- IPv4 ranges ---
  ['0.0.0.0', BLOCK, '0.0.0.0/8 start'],
  ['0.255.255.255', BLOCK, '0.0.0.0/8 end'],
  ['1.0.0.0', FREE, 'first address outside 0/8'],
  ['10.0.0.0', BLOCK, '10/8 start'],
  ['10.255.255.255', BLOCK, '10/8 end'],
  ['11.0.0.0', FREE, 'outside 10/8'],
  ['100.63.255.255', FREE, 'below CGNAT'],
  ['100.64.0.0', BLOCK, '100.64.0.0/10 start'],
  ['100.127.255.255', BLOCK, '100.64.0.0/10 end'],
  ['100.128.0.0', FREE, 'above CGNAT'],
  ['126.255.255.255', FREE, 'below loopback'],
  ['127.0.0.0', BLOCK, '127/8 start'],
  ['127.0.0.1', BLOCK, 'loopback'],
  ['127.255.255.255', BLOCK, '127/8 end'],
  ['128.0.0.0', FREE, 'outside loopback'],
  ['169.253.255.255', FREE, 'below link-local'],
  ['169.254.0.0', BLOCK, '169.254/16 start (cloud metadata)'],
  ['169.254.169.254', BLOCK, 'cloud metadata literal'],
  ['169.255.0.0', FREE, 'above link-local'],
  ['172.15.255.255', FREE, 'below 172.16/12'],
  ['172.16.0.0', BLOCK, '172.16/12 start'],
  ['172.31.255.255', BLOCK, '172.16/12 end'],
  ['172.32.0.0', FREE, 'above 172.16/12'],
  ['191.255.255.255', FREE, 'below 192.0.0/24'],
  ['192.0.0.0', BLOCK, '192.0.0.0/24 start'],
  ['192.0.0.255', BLOCK, '192.0.0.0/24 end'],
  ['192.0.1.0', FREE, 'above 192.0.0/24'],
  ['192.167.255.255', FREE, 'below 192.168/16'],
  ['192.168.0.0', BLOCK, '192.168/16 start'],
  ['192.168.255.255', BLOCK, '192.168/16 end'],
  ['192.169.0.0', FREE, 'above 192.168/16'],
  ['198.17.255.255', FREE, 'below 198.18/15'],
  ['198.18.0.0', BLOCK, '198.18/15 start'],
  ['198.19.255.255', BLOCK, '198.18/15 end'],
  ['198.20.0.0', FREE, 'above 198.18/15'],
  ['223.255.255.255', FREE, 'below multicast'],
  ['224.0.0.0', BLOCK, '224/4 start (multicast)'],
  ['239.255.255.255', BLOCK, '224/4 end'],
  ['240.0.0.0', BLOCK, '240/4 start'],
  ['240.0.0.1', BLOCK, '240/4 interior'],
  ['255.255.255.255', BLOCK, '240/4 end (broadcast)'],
  ['8.8.8.8', FREE, 'public'],
  ['172.64.0.1', FREE, 'public near CGNAT side'],

  // --- IPv6 ranges ---
  ['::', BLOCK, 'unspecified'],
  ['::1', BLOCK, 'loopback'],
  ['::2', FREE, 'above loopback'],
  ['fc00::1', BLOCK, 'fc00::/7'],
  ['fd00::1', BLOCK, 'inside fc00::/7 (fd00::/8)'],
  ['fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', BLOCK, 'fc00::/7 top edge'],
  ['fe00::1', FREE, 'below fe80/10'],
  ['fe80::1', BLOCK, 'fe80::/10 start'],
  ['febf::1', BLOCK, 'fe80::/10 end'],
  ['fec0::1', FREE, 'above fe80/10'],
  ['ff01::1', BLOCK, 'ff00::/8'],
  ['ff02::1', BLOCK, 'multicast'],
  ['ffff::1', BLOCK, 'ff00::/8 high'],
  ['2001:db8::1', FREE, 'documentation range — public'],
  ['2606:4700::1111', FREE, 'public'],

  // --- IPv6 variants of syntax ---
  ['FE80::1', BLOCK, 'case-insensitive'],
  ['0:0:0:0:0:0:0:1', BLOCK, 'fully expanded loopback'],
  ['::ffff:0:0', BLOCK, 'IPv4-mapped zero (192.0.0.0)'],
  ['::ffff:127.0.0.1', BLOCK, 'mapped loopback'],
  ['::ffff:7f00:1', BLOCK, 'mapped loopback, hex form'],
  ['::ffff:169.254.169.254', BLOCK, 'mapped metadata'],
  ['::ffff:10.0.0.5', BLOCK, 'mapped private'],
  ['::ffff:172.16.0.9', BLOCK, 'mapped 172.16/12'],
  ['::ffff:8.8.8.8', FREE, 'mapped public'],
  ['64:ff9b::7f00:1', BLOCK, 'NAT64 to 127.0.0.1'],
  ['64:ff9b::c000:201', FREE, 'NAT64 to 192.0.2.1'],
  ['64:ff9b::1.2.3.4', FREE, 'NAT64 dotted form, public'],
  ['64:ff9b::ffff', BLOCK, 'NAT64 to 0.0.0.255'],
  ['fe80::1%25eth0', BLOCK, 'zone id stripped, link-local'],
  ['2001:db8::1%251', FREE, 'zone id stripped, public'],
]

describe('isBlockedAddress', () => {
  for (const [address, expected, label] of CASES) {
    if (expected === 'throws') {
      it(`${label}: ${address} throws`, () => {
        expect(() => isBlockedAddress(address)).toThrow()
      })
    } else if (expected === BLOCK) {
      it(`${label}: ${address} → blocked`, () => {
        expect(isBlockedAddress(address)).toBe(true)
      })
    } else {
      it(`${label}: ${address} → not blocked`, () => {
        expect(isBlockedAddress(address)).toBe(false)
      })
    }
  }
})
