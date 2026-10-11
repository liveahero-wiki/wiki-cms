// Pure TS (no Worker-only imports): shared with the CLI.

function expandIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase()
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  // Embedded IPv4 tail (::ffff:1.2.3.4)
  const v4 = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (v4) {
    const parts = v4[2]!.split('.').map(Number)
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
    s = v4[1]! + ((parts[0]! << 8) | parts[1]!).toString(16) + ':' + ((parts[2]! << 8) | parts[3]!).toString(16)
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  if (groups.length !== 8) return null
  const out: number[] = []
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    out.push(parseInt(g, 16))
  }
  return out
}

function isIpv4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  return !!m && m.slice(1).every((p) => Number(p) <= 255)
}

/**
 * Normalize an IP to the key used for rate limits and blocks:
 * IPv4 as-is, IPv6 truncated to its /64 prefix (`2001:db8:0:1::`-style, lower-case hex groups).
 * Returns null if `ip` is not a valid address.
 */
export function ipKey(ip: string): string | null {
  const trimmed = ip.trim()
  if (isIpv4(trimmed)) return trimmed.split('.').map(Number).join('.')
  if (!trimmed.includes(':')) return null
  const groups = expandIpv6(trimmed)
  if (!groups) return null
  // IPv4-mapped (::ffff:a.b.c.d) → treat as the IPv4 address.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`
  }
  return groups.slice(0, 4).map((g) => g.toString(16)).join(':') + '::'
}
