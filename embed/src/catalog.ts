// Pure logic of the `catalog` layout (search, tag match, sort, URL hash). No DOM, no framework: unit tested in catalog.test.ts.
import type { PublicItem } from '../../src/shared/api-types.ts'
import { LANGS, type Lang } from '../../src/shared/i18n.ts'

/** Hash keys owned by the core; every other key belongs to the plugin's `listFilter`. */
export const CORE_KEYS = ['q', 'sort', 'lang'] as const
export const TAG_PREFIX = 't.'

export const SORT_NEWEST = 'newest'
export const SORT_OLDEST = 'oldest'

export interface CatalogState {
  /** Raw search text (normalised when matching). */
  q: string
  sort: string
  lang: 'all' | Lang
  /** tag key -> selected values ("any of"; missing/empty = no constraint). */
  tags: Record<string, string[]>
}

export const emptyState = (): CatalogState => ({ q: '', sort: SORT_NEWEST, lang: 'all', tags: {} })

/** Case-insensitive, NFKC-normalised form used for the title search. */
export const normalizeSearch = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()

/** Every whitespace-separated word of the query must occur in the title. */
export function matchesQuery(title: string, q: string): boolean {
  const words = normalizeSearch(q).split(' ').filter(Boolean)
  if (!words.length) return true
  const hay = normalizeSearch(title)
  return words.every((w) => hay.includes(w))
}

export function matchesTags(itemTags: Record<string, string>, selected: Record<string, string[]>): boolean {
  for (const [key, values] of Object.entries(selected)) {
    if (!values.length) continue
    const v = itemTags[key]
    if (v === undefined || !values.includes(v)) return false
  }
  return true
}

export interface Parsed {
  core: CatalogState
  /** Hash params the core does not own (passed to the plugin's `listFilter.init`). */
  rest: URLSearchParams
}

/**
 * Parse a location hash. Unknown tag keys/values and unknown languages are dropped; an unknown `sort` is kept
 * (the plugin may provide it) and validated by the caller against the available sorts.
 */
export function parseHash(hash: string, tagDefs: { key: string; options: { value: string }[] }[]): Parsed {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  const core = emptyState()
  const rest = new URLSearchParams()
  for (const [k, v] of params) {
    if (k === 'q') core.q = v.slice(0, 200)
    else if (k === 'sort') core.sort = v || SORT_NEWEST
    else if (k === 'lang') core.lang = (LANGS as readonly string[]).includes(v) ? (v as Lang) : 'all'
    else if (k.startsWith(TAG_PREFIX)) {
      const def = tagDefs.find((d) => d.key === k.slice(TAG_PREFIX.length))
      if (!def) continue
      const values = [...new Set(v.split(',').filter((x) => def.options.some((o) => o.value === x)))]
      if (values.length) core.tags[def.key] = values
    } else rest.append(k, v)
  }
  return { core, rest }
}

const enc = (s: string) => encodeURIComponent(s).replace(/%2C/gi, ',')

/** Serialise non-default core state plus the plugin's params into a hash ('' when everything is default). */
export function serializeHash(core: CatalogState, pluginParams: Record<string, string> = {}): string {
  const parts: string[] = []
  if (core.q.trim()) parts.push(`q=${enc(core.q.trim())}`)
  if (core.sort !== SORT_NEWEST) parts.push(`sort=${enc(core.sort)}`)
  if (core.lang !== 'all') parts.push(`lang=${enc(core.lang)}`)
  for (const [k, values] of Object.entries(core.tags)) {
    if (values.length) parts.push(`${TAG_PREFIX}${enc(k)}=${values.map(enc).join(',')}`)
  }
  for (const [k, v] of Object.entries(pluginParams)) parts.push(`${enc(k)}=${enc(v)}`)
  return parts.length ? `#${parts.join('&')}` : ''
}

/** Number of active core filters (search, language and tag groups; the sort is not a filter). */
export function activeCoreCount(core: CatalogState): { basic: number; advanced: number } {
  return {
    basic: core.q.trim() ? 1 : 0,
    advanced: (core.lang !== 'all' ? 1 : 0) + Object.values(core.tags).filter((v) => v.length).length,
  }
}

export interface PluginSort {
  key: string
  compare(a: unknown, b: unknown): number
}

/** Newest first is the blob order (createdAt DESC, id DESC); a stable sort keeps it as the tie-break. */
export function sortItems<T extends Pick<PublicItem, 'createdAt' | 'payload'>>(items: T[], sort: string, pluginSorts: PluginSort[] = []): T[] {
  const byNewest = (a: T, b: T) => b.createdAt - a.createdAt
  if (sort === SORT_OLDEST) return [...items].sort((a, b) => -byNewest(a, b))
  const ps = pluginSorts.find((s) => s.key === sort)
  if (!ps) return [...items].sort(byNewest)
  return [...items].sort((a, b) => {
    let c = 0
    try {
      c = ps.compare(a.payload, b.payload)
    } catch {
      /* a failing plugin sort keeps the newest-first order */
    }
    return c || byNewest(a, b)
  })
}

export interface FilterOpts {
  /** The plugin's `test`; must not throw (the caller wraps it). */
  test?: (payload: unknown) => boolean
}

export function filterItems<T extends Pick<PublicItem, 'title' | 'lang' | 'tags' | 'payload'>>(items: T[], core: CatalogState, opts: FilterOpts = {}): T[] {
  return items.filter(
    (i) =>
      (core.lang === 'all' || i.lang === core.lang) &&
      matchesQuery(i.title, core.q) &&
      matchesTags(i.tags, core.tags) &&
      (opts.test ? opts.test(i.payload) : true),
  )
}
