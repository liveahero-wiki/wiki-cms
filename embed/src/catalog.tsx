// The `catalog` layout: one list of every item of a group with search, tag/language filters, sorting and "show more".
// All filtering happens in memory on the one blob; the filter state lives in the URL hash (deep links such as #hero=12641).
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { PublicBlob } from '../../src/shared/api-types.ts'
import { pickText } from '../../src/shared/i18n.ts'
import type { ListFilter } from '../../src/shared/plugin-api.ts'
import {
  SORT_NEWEST,
  SORT_OLDEST,
  activeCoreCount,
  emptyState,
  filterItems,
  parseHash,
  serializeHash,
  sortItems,
  type CatalogState,
} from './catalog.ts'
import { Card, Chip, type Ctx, type PluginState } from './cards.tsx'
import { t } from './i18n/t.ts'
import type { Lang } from './shared.ts'

const PAGE = 20
const SEARCH_DEBOUNCE_MS = 200

type Filter = ListFilter<unknown, unknown>

/** Mounts one plugin filter part into a core-owned container; remounts when the UI language (ctx) changes. */
function PluginPart({ filter, part, ctx, state, onChange, hidden }: { filter: Filter; part: 'basic' | 'advanced'; ctx: Ctx; state: unknown; onChange(s: unknown): void; hidden?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const handle = useRef<{ update(s: unknown): void; destroy(): void } | null>(null)
  const latest = useRef({ state, onChange })
  latest.current = { state, onChange }
  useEffect(() => {
    const el = ref.current
    if (!el) return
    try {
      handle.current = filter.mount(el, part, latest.current.state, (s) => latest.current.onChange(s), ctx)
    } catch (e) {
      console.warn('[wiki-cms] plugin filter failed to mount', e)
    }
    return () => {
      try {
        handle.current?.destroy()
      } catch {
        /* ignore plugin cleanup errors */
      }
      handle.current = null
      el.replaceChildren()
    }
  }, [filter, part, ctx])
  useEffect(() => {
    try {
      handle.current?.update(state)
    } catch (e) {
      console.warn('[wiki-cms] plugin filter update failed', e)
    }
  }, [state, filter, part, ctx])
  return <div ref={ref} class={`cms-lf cms-lf-${part}`} hidden={hidden} />
}

export function Catalog({ blob, uiLang, plugin, ctx }: { blob: PublicBlob; uiLang: Lang; plugin: PluginState; ctx: Ctx }) {
  const tagDefs = blob.meta.tags
  const filter: Filter | undefined = plugin.s === 'ready' ? (plugin.plugin.listFilter as Filter | undefined) : undefined
  const warned = useRef(false)
  const warnOnce = (what: string, e: unknown) => {
    if (warned.current) return
    warned.current = true
    console.warn(`[wiki-cms] plugin ${what} failed; treating it as a no-op`, e)
  }

  const [core, setCore] = useState<CatalogState>(() => parseHash(location.hash, tagDefs).core)
  const [qInput, setQInput] = useState(core.q)
  const [pstate, setPstate] = useState<unknown>(undefined)
  const [ready, setReady] = useState(false) // the plugin finished loading and prepare() ran
  const [advanced, setAdvanced] = useState(false)
  const [shown, setShown] = useState(PAGE)
  const dirty = useRef(false) // only user changes are written back to the hash
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx

  const initPluginState = useCallback(
    (rest: URLSearchParams): unknown => {
      if (!filter) return undefined
      try {
        return filter.init(rest, ctxRef.current)
      } catch (e) {
        warnOnce('init', e)
        return undefined
      }
    },
    [filter],
  )

  // Wait for the plugin (it may be slow or fail): filtering with a half-initialised state would flash wrong results.
  useEffect(() => {
    if (plugin.s === 'loading') return
    let dead = false
    ;(async () => {
      try {
        await filter?.prepare?.()
      } catch (e) {
        warnOnce('prepare', e)
      }
      if (dead) return
      setPstate(initPluginState(parseHash(location.hash, tagDefs).rest))
      setReady(true)
    })()
    return () => {
      dead = true
    }
  }, [plugin.s, filter])

  // Back/forward and in-page links to another #hash.
  useEffect(() => {
    const onHash = () => {
      const p = parseHash(location.hash, tagDefs)
      dirty.current = false
      setCore(p.core)
      setQInput(p.core.q)
      setPstate(initPluginState(p.rest))
      setShown(PAGE)
    }
    addEventListener('hashchange', onHash)
    return () => removeEventListener('hashchange', onHash)
  }, [tagDefs, initPluginState])

  const sorts = useMemo(() => (filter?.sorts ?? []).map((s) => ({ key: s.key, label: s.label(uiLang), compare: s.compare as (a: unknown, b: unknown) => number })), [filter, uiLang])
  const sortKey = core.sort === SORT_NEWEST || core.sort === SORT_OLDEST || sorts.some((s) => s.key === core.sort) ? core.sort : SORT_NEWEST

  const test = useMemo(() => {
    if (!filter || pstate === undefined) return undefined
    return (payload: unknown) => {
      try {
        return filter.test(payload, pstate)
      } catch (e) {
        warnOnce('test', e)
        return true
      }
    }
  }, [filter, pstate])

  const results = useMemo(
    () => (ready ? sortItems(filterItems(blob.items, core, { test }), sortKey, sorts) : []),
    [ready, blob.items, core, test, sortKey, sorts],
  )

  const pluginParams = useMemo<Record<string, string>>(() => {
    if (!filter || pstate === undefined) return {}
    try {
      return filter.toParams(pstate)
    } catch (e) {
      warnOnce('toParams', e)
      return {}
    }
  }, [filter, pstate])

  // Mirror the state into the hash (replaceState: no history entries, no hashchange event).
  useEffect(() => {
    if (!ready || !dirty.current) return
    const hash = serializeHash({ ...core, sort: sortKey }, pluginParams)
    if (hash === location.hash || (!hash && !location.hash)) return
    try {
      history.replaceState(history.state, '', location.pathname + location.search + hash)
    } catch {
      /* sandboxed frames may forbid it */
    }
  }, [ready, core, sortKey, pluginParams])

  const updateCore = (patch: Partial<CatalogState>) => {
    dirty.current = true
    setShown(PAGE)
    setCore((c) => ({ ...c, ...patch }))
  }
  const updatePlugin = (s: unknown) => {
    dirty.current = true
    setShown(PAGE)
    setPstate(s)
  }

  // Debounced search box.
  useEffect(() => {
    if (qInput === core.q) return
    const id = setTimeout(() => updateCore({ q: qInput }), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [qInput])

  const toggleTag = (key: string, value: string) => {
    const cur = core.tags[key] ?? []
    const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]
    const tags = { ...core.tags, [key]: next }
    if (!next.length) delete tags[key]
    updateCore({ tags })
  }

  const clear = () => {
    dirty.current = true
    setShown(PAGE)
    setCore((c) => ({ ...emptyState(), sort: c.sort }))
    setQInput('')
    setPstate(initPluginState(new URLSearchParams()))
  }

  let pluginActive = 0
  try {
    pluginActive = filter && pstate !== undefined ? filter.activeCount(pstate) : 0
  } catch (e) {
    warnOnce('activeCount', e)
  }
  const counts = activeCoreCount(core)
  const advancedActive = counts.advanced + pluginActive
  const anyActive = counts.basic + counts.advanced > 0 || Object.keys(pluginParams).length > 0

  if (!ready) {
    return (
      <div class="cms-skeleton" aria-hidden="true">
        <span /> <span />
      </div>
    )
  }

  const presentLangs = blob.meta.langs.filter((l) => blob.items.some((i) => i.lang === l.value))
  const visible = results.slice(0, shown)
  const showTagGroups = tagDefs.length > 0
  const showAdvanced = showTagGroups || presentLangs.length > 1 || !!filter

  return (
    <div class="cms-catalog">
      <div class="cms-controls">
        <div class="cms-controls-basic">
          <input
            type="search"
            class="cms-input cms-search"
            value={qInput}
            placeholder={t(uiLang, 'catalog.search')}
            aria-label={t(uiLang, 'catalog.search')}
            autocomplete="off"
            onInput={(e) => setQInput((e.currentTarget as HTMLInputElement).value)}
          />
          {filter && <PluginPart filter={filter} part="basic" ctx={ctx} state={pstate} onChange={updatePlugin} />}
        </div>
        <div class="cms-controls-row">
          {showAdvanced && (
            <button type="button" class="cms-btn" aria-expanded={advanced} aria-controls="cms-advanced" onClick={() => setAdvanced((x) => !x)}>
              {t(uiLang, 'catalog.advanced')}
              {advancedActive > 0 && (
                <span class="cms-badge" aria-label={t(uiLang, 'catalog.activeCount', { count: advancedActive })}>
                  {advancedActive}
                </span>
              )}
            </button>
          )}
          <label class="cms-sort">
            <span>{t(uiLang, 'catalog.sort')}</span>
            <select class="cms-input" value={sortKey} onChange={(e) => updateCore({ sort: (e.currentTarget as HTMLSelectElement).value })}>
              <option value={SORT_NEWEST}>{t(uiLang, 'catalog.sort.newest')}</option>
              <option value={SORT_OLDEST}>{t(uiLang, 'catalog.sort.oldest')}</option>
              {sorts.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div id="cms-advanced" class="cms-advanced" hidden={!advanced}>
          {tagDefs.map((def) => (
            <div key={def.key} class="cms-filter-group" role="group" aria-label={pickText(def.label, uiLang)}>
              <span class="cms-filter-label">{pickText(def.label, uiLang)}</span>
              {def.options.map((o) => (
                <Chip key={o.value} active={(core.tags[def.key] ?? []).includes(o.value)} onClick={() => toggleTag(def.key, o.value)}>
                  {pickText(o.label, uiLang)}
                </Chip>
              ))}
            </div>
          ))}
          {presentLangs.length > 1 && (
            <div class="cms-filter-group" role="group" aria-label={t(uiLang, 'list.filterLabel')}>
              <span class="cms-filter-label">{t(uiLang, 'list.filterLabel')}</span>
              <Chip active={core.lang === 'all'} onClick={() => updateCore({ lang: 'all' })}>
                {t(uiLang, 'list.filterAll')}
              </Chip>
              {presentLangs.map((l) => (
                <Chip key={l.value} active={core.lang === l.value} onClick={() => updateCore({ lang: l.value })}>
                  {l.label}
                </Chip>
              ))}
            </div>
          )}
          {filter && <PluginPart filter={filter} part="advanced" ctx={ctx} state={pstate} onChange={updatePlugin} />}
        </div>
      </div>

      <div class="cms-results-bar" aria-live="polite">
        <span class="cms-results">{t(uiLang, 'catalog.results', { shown: visible.length, count: results.length })}</span>
        {anyActive && (
          <button type="button" class="cms-link" onClick={clear}>
            {t(uiLang, 'catalog.clear')}
          </button>
        )}
      </div>

      {blob.items.length === 0 ? (
        <p class="cms-empty">{t(uiLang, 'list.empty')}</p>
      ) : results.length === 0 ? (
        <p class="cms-empty">{t(uiLang, 'catalog.noMatch')}</p>
      ) : (
        <>
          <ul class="cms-list">
            {visible.map((item) => (
              <li key={item.id} class="cms-card">
                <Card item={item} blob={blob} uiLang={uiLang} plugin={plugin} ctx={ctx} />
              </li>
            ))}
          </ul>
          {results.length > shown && (
            <button type="button" class="cms-btn cms-more" onClick={() => setShown((n) => n + PAGE)}>
              {t(uiLang, 'list.showMore')}
            </button>
          )}
        </>
      )}
    </div>
  )
}
