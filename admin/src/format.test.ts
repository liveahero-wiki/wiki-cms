import { describe, expect, it } from 'vitest'
import { flagEmoji, formatRelative } from './format.ts'

describe('format', () => {
  it('formats relative times', () => {
    const now = 1_800_000_000_000
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5 minutes ago')
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe('3 hours ago')
    expect(formatRelative(now - 86_400_000, now)).toBe('yesterday')
    expect(formatRelative(now - 10_000, now)).toBe('just now')
    expect(formatRelative(now + 2 * 3_600_000, now)).toBe('in 2 hours')
  })
  it('builds flag emoji only for two-letter codes', () => {
    expect(flagEmoji('jp')).toBe('🇯🇵')
    expect(flagEmoji('US')).toBe('🇺🇸')
    expect(flagEmoji('')).toBe('')
    expect(flagEmoji(null)).toBe('')
    expect(flagEmoji('USA')).toBe('')
  })
})
