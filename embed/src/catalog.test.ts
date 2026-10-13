import { describe, expect, it } from 'vitest'
import { activeCoreCount, emptyState, filterItems, matchesQuery, matchesTags, normalizeSearch, parseHash, serializeHash, sortItems, type CatalogState } from './catalog.ts'

const tagDefs = [
  { key: 'teamType', options: [{ value: 'manual' }, { value: 'auto' }] },
  { key: 'successRate', options: [{ value: 'high' }, { value: 'medium' }, { value: 'low' }] },
]
const item = (id: string, createdAt: number, over: Record<string, unknown> = {}) => ({
  id,
  createdAt,
  title: `Team ${id}`,
  lang: 'en' as const,
  tags: { teamType: 'manual', successRate: 'high' } as Record<string, string>,
  payload: { n: Number(id.replace(/\D/g, '')) || 0 } as unknown,
  ...over,
})

describe('search', () => {
  it('is case-insensitive, NFKC-normalised and matches every word', () => {
    expect(normalizeSearch('  ＳＳＳ   Team ')).toBe('sss team')
    expect(matchesQuery('SSS Lantern 3-turn clear', 'lantern sss')).toBe(true)
    expect(matchesQuery('SSS Lantern 3-turn clear', 'ＬＡＮＴＥＲＮ')).toBe(true)
    expect(matchesQuery('SSS Lantern', 'lantern auto')).toBe(false)
    expect(matchesQuery('三回合通关', '回合')).toBe(true)
    expect(matchesQuery('', '')).toBe(true)
    expect(matchesQuery('', 'x')).toBe(false)
  })
})

describe('tag matching', () => {
  it('is "any of" within a tag and "all" across tags; empty selections are ignored', () => {
    const t = { teamType: 'auto', successRate: 'low' }
    expect(matchesTags(t, {})).toBe(true)
    expect(matchesTags(t, { teamType: [] })).toBe(true)
    expect(matchesTags(t, { teamType: ['manual', 'auto'] })).toBe(true)
    expect(matchesTags(t, { teamType: ['manual'] })).toBe(false)
    expect(matchesTags(t, { teamType: ['auto'], successRate: ['high', 'medium'] })).toBe(false)
    expect(matchesTags({}, { teamType: ['auto'] })).toBe(false)
  })
})

describe('hash', () => {
  it('round-trips core state and leaves unknown keys to the plugin', () => {
    const { core, rest } = parseHash('#q=sss%20auto&sort=oldest&lang=ja&t.teamType=manual,auto&hero=12641&xhero=1,2&tree=0', tagDefs)
    expect(core).toEqual({ q: 'sss auto', sort: 'oldest', lang: 'ja', tags: { teamType: ['manual', 'auto'] } })
    expect(Object.fromEntries(rest)).toEqual({ hero: '12641', xhero: '1,2', tree: '0' })
    expect(serializeHash(core, Object.fromEntries(rest))).toBe('#q=sss%20auto&sort=oldest&lang=ja&t.teamType=manual,auto&hero=12641&xhero=1,2&tree=0')
  })
  it('omits defaults and returns an empty string when nothing is set', () => {
    expect(serializeHash(emptyState())).toBe('')
    expect(serializeHash({ ...emptyState(), q: '  ' })).toBe('')
    expect(serializeHash(emptyState(), { target: 'quest-616001' })).toBe('#target=quest-616001')
  })
  it('drops unknown tag keys, unknown tag values and unknown languages; accepts a hash without #', () => {
    const { core } = parseHash('t.nope=x&t.teamType=bogus&t.successRate=low,bogus&lang=xx&q=a', tagDefs)
    expect(core).toEqual({ q: 'a', sort: 'newest', lang: 'all', tags: { successRate: ['low'] } })
    expect(parseHash('', tagDefs).core).toEqual(emptyState())
    expect(parseHash('#', tagDefs).core).toEqual(emptyState())
  })
  it('handles percent-encoded commas and encodes awkward search text', () => {
    expect(parseHash('#t.successRate=high%2Clow', tagDefs).core.tags).toEqual({ successRate: ['high', 'low'] })
    const s = serializeHash({ ...emptyState(), q: 'a&b=c#d' })
    expect(parseHash(s, tagDefs).core.q).toBe('a&b=c#d')
  })
})

describe('sorting and filtering', () => {
  const items = [item('3', 3000), item('2', 2000), item('1', 1000)]
  it('newest (default and unknown keys), oldest, and plugin sorts with newest as the tie-break', () => {
    expect(sortItems(items, 'newest').map((i) => i.id)).toEqual(['3', '2', '1'])
    expect(sortItems(items, 'bogus').map((i) => i.id)).toEqual(['3', '2', '1'])
    expect(sortItems(items, 'oldest').map((i) => i.id)).toEqual(['1', '2', '3'])
    const byParity = { key: 'parity', compare: (a: unknown, b: unknown) => ((a as { n: number }).n % 2) - ((b as { n: number }).n % 2) }
    expect(sortItems(items, 'parity', [byParity]).map((i) => i.id)).toEqual(['2', '3', '1'])
    const broken = { key: 'broken', compare: () => { throw new Error('boom') } }
    expect(sortItems(items, 'broken', [broken]).map((i) => i.id)).toEqual(['3', '2', '1'])
    expect(items.map((i) => i.id)).toEqual(['3', '2', '1']) // input is not mutated
  })
  it('combines title, language, tags and the plugin test', () => {
    const list = [
      item('1', 1, { title: 'SSS auto', tags: { teamType: 'auto', successRate: 'low' } }),
      item('2', 2, { title: 'SSS manual', lang: 'ja' }),
      item('3', 3, { title: '', payload: { n: 9 } }),
    ]
    const state = (over: Partial<CatalogState>): CatalogState => ({ ...emptyState(), ...over })
    expect(filterItems(list, state({ q: 'sss' })).map((i) => i.id)).toEqual(['1', '2'])
    expect(filterItems(list, state({ lang: 'ja' })).map((i) => i.id)).toEqual(['2'])
    expect(filterItems(list, state({ tags: { teamType: ['auto'] } })).map((i) => i.id)).toEqual(['1'])
    expect(filterItems(list, state({}), { test: (p) => (p as { n: number }).n === 9 }).map((i) => i.id)).toEqual(['3'])
    expect(filterItems(list, state({ q: 'zzz' }))).toEqual([])
  })
  it('counts active core filters', () => {
    expect(activeCoreCount(emptyState())).toEqual({ basic: 0, advanced: 0 })
    expect(activeCoreCount({ q: 'x', sort: 'oldest', lang: 'ja', tags: { teamType: ['auto'], successRate: [] } })).toEqual({ basic: 1, advanced: 2 })
  })
})
