const abs = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })
const rel = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

export const formatAbsolute = (ms: number): string => abs.format(new Date(ms))

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
]

/** "5 minutes ago", "yesterday", "in 2 hours". */
export function formatRelative(ms: number, now = Date.now()): string {
  const diff = ms - now
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size) return rel.format(Math.round(diff / size), unit)
  }
  return 'just now'
}

/** ISO 3166 alpha-2 code → flag emoji (regional indicator symbols); '' for anything else. */
export function flagEmoji(code: string | null | undefined): string {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return ''
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)))
}
