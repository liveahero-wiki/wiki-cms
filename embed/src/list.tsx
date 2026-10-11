import { Component, render, type ComponentChildren } from 'preact'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { PublicBlob, PublicItem, TagDefDto, TypeConfig } from '../../src/shared/api-types.ts'
import { pickText } from '../../src/shared/i18n.ts'
import type { SubmissionPlugin } from '../../src/shared/plugin-api.ts'
import { t } from './i18n/t.ts'
import {
  demoPlatform,
  fetchBlob,
  fetchConfig,
  injectStyle,
  isLang,
  langFromTag,
  loadPlugin,
  makeCtx,
  parseHttps,
  resolveUiLang,
  type Lang,
  type ListOpts,
} from './shared.ts'

const PAGE = 10

type PluginState = { s: 'loading' } | { s: 'failed' } | { s: 'ready'; plugin: SubmissionPlugin }

/** UI language: data-cms-lang → <html lang> → navigator → en, re-resolved on `cms:lang`. */
function useUiLang(host: HTMLElement): Lang {
  const [lang, setLang] = useState(() => resolveUiLang(host))
  useEffect(() => {
    const onLang = (e: Event) => {
      const d = (e as CustomEvent).detail
      const l = typeof d === 'string' ? (isLang(d) ? d : langFromTag(d)) : null
      if (l) host.setAttribute('data-cms-lang', l)
      setLang(resolveUiLang(host))
    }
    // Events dispatched on the host (or bubbling from inside it) reach `host`; events dispatched on an ancestor
    // (e.g. <html>/document) reach `document` only.
    const onAncestor = (e: Event) => {
      const n = e.target as Node
      if (n !== host && n.contains?.(host)) onLang(e)
    }
    host.addEventListener('cms:lang', onLang)
    document.addEventListener('cms:lang', onAncestor)
    return () => {
      host.removeEventListener('cms:lang', onLang)
      document.removeEventListener('cms:lang', onAncestor)
    }
  }, [host])
  return lang
}

type BlobState = { s: 'loading' } | { s: 'error' } | { s: 'ok'; blob: PublicBlob }

function App({ host, opts }: { host: HTMLElement; opts: ListOpts }) {
  const uiLang = useUiLang(host)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<BlobState>({ s: 'loading' })
  const [plugin, setPlugin] = useState<PluginState>({ s: 'loading' })
  const [cfg, setCfg] = useState<TypeConfig | null>(null)
  const [filter, setFilter] = useState<'all' | Lang>('all')
  const [shown, setShown] = useState(PAGE)
  const [opening, setOpening] = useState(false)
  const [formError, setFormError] = useState(false)

  useEffect(() => {
    let dead = false
    setState({ s: 'loading' })
    fetchBlob(opts).then(
      (blob) => !dead && setState({ s: 'ok', blob }),
      (e) => {
        console.warn('[wiki-cms] could not load submissions', e)
        if (!dead) setState({ s: 'error' })
      },
    )
    return () => {
      dead = true
    }
  }, [opts, attempt])

  // The plugin is imported once per page (memoized by URL); a failure only affects the cards.
  useEffect(() => {
    let dead = false
    setPlugin({ s: 'loading' })
    loadPlugin(opts.plugin).then(
      (p) => !dead && setPlugin({ s: 'ready', plugin: p }),
      (e) => {
        console.warn('[wiki-cms] plugin unavailable', e)
        if (!dead) setPlugin({ s: 'failed' })
      },
    )
    return () => {
      dead = true
    }
  }, [opts, attempt])

  // Background fetch of the type config for the (optional) disclaimer override; failures keep the default.
  useEffect(() => {
    let dead = false
    fetchConfig(opts).then(
      (c) => !dead && setCfg(c),
      () => {},
    )
    return () => {
      dead = true
    }
  }, [opts])

  const blob = state.s === 'ok' ? state.blob : null
  const ctx = useMemo(() => makeCtx(opts, uiLang, blob?.groupOptions ?? {}), [opts, uiLang, blob])

  const openForm = async () => {
    if (!blob || opening) return
    setOpening(true)
    setFormError(false)
    try {
      const m = await import('./form.tsx')
      m.openForm({ host, opts, uiLang, groupOptions: blob.groupOptions })
    } catch (e) {
      console.warn('[wiki-cms] could not open the form', e)
      setFormError(true)
    } finally {
      setOpening(false)
    }
  }

  const disclaimer = cfg?.disclaimer ? pickText(cfg.disclaimer, uiLang) : t(uiLang, 'disclaimer')

  let body: ComponentChildren
  if (state.s === 'error') {
    body = (
      <div class="cms-status" role="alert">
        <p>{t(uiLang, 'list.loadError')}</p>
        <button type="button" class="cms-btn" onClick={() => setAttempt((n) => n + 1)}>
          {t(uiLang, 'list.retry')}
        </button>
      </div>
    )
  } else if (state.s === 'loading') {
    body = (
      <div class="cms-skeleton" aria-hidden="true">
        <span /> <span />
      </div>
    )
  } else {
    const items = state.blob.items
    const present = state.blob.meta.langs.filter((l) => items.some((i) => i.lang === l.value))
    const visibleItems = filter === 'all' ? items : items.filter((i) => i.lang === filter)
    body = items.length === 0 ? (
      <p class="cms-empty">{t(uiLang, 'list.empty')}</p>
    ) : (
      <>
        <div class="cms-filter" role="group" aria-label={t(uiLang, 'list.filterLabel')}>
          <Chip active={filter === 'all'} onClick={() => (setFilter('all'), setShown(PAGE))}>
            {t(uiLang, 'list.filterAll')}
          </Chip>
          {present.map((l) => (
            <Chip key={l.value} active={filter === l.value} onClick={() => (setFilter(l.value), setShown(PAGE))}>
              {l.label}
            </Chip>
          ))}
        </div>
        <ul class="cms-list">
          {visibleItems.slice(0, shown).map((item) => (
            <li key={item.id} class="cms-card">
              <Card item={item} blob={state.blob} uiLang={uiLang} plugin={plugin} ctx={ctx} />
            </li>
          ))}
        </ul>
        {visibleItems.length > shown && (
          <button type="button" class="cms-btn cms-more" onClick={() => setShown((n) => n + PAGE)}>
            {t(uiLang, 'list.showMore')}
          </button>
        )}
      </>
    )
  }

  return (
    <div class="cms-app">
      <p class="cms-disclaimer">{disclaimer}</p>
      <div class="cms-toolbar">
        <button type="button" class="cms-btn cms-primary" disabled={!blob || opening} onClick={openForm}>
          {opening ? t(uiLang, 'list.opening') : t(uiLang, 'list.submit')}
        </button>
        {formError && (
          <span class="cms-error" role="alert">
            {t(uiLang, 'list.formError')}
          </span>
        )}
      </div>
      {body}
    </div>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick(): void; children: ComponentChildren }) {
  return (
    <button type="button" class={`cms-chip cms-chip-btn${active ? ' cms-active' : ''}`} aria-pressed={active} onClick={onClick}>
      {children}
    </button>
  )
}

function Card({
  item,
  blob,
  uiLang,
  plugin,
  ctx,
}: {
  item: PublicItem
  blob: PublicBlob
  uiLang: Lang
  plugin: PluginState
  ctx: ReturnType<typeof makeCtx>
}) {
  const tagChips = blob.meta.tags.flatMap((def: TagDefDto) => {
    const v = item.tags[def.key]
    const opt = v === undefined ? undefined : def.options.find((o) => o.value === v)
    return opt ? [`${pickText(def.label, uiLang)}: ${pickText(opt.label, uiLang)}`] : []
  })
  const langLabel = blob.meta.langs.find((l) => l.value === item.lang)?.label ?? item.lang
  const date = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(uiLang, { dateStyle: 'medium' }).format(item.createdAt)
    } catch {
      return new Date(item.createdAt).toISOString().slice(0, 10)
    }
  }, [uiLang, item.createdAt])
  const demo = parseHttps(item.demoUrl)
  const platform = demo ? demoPlatform(demo.hostname) : null

  return (
    <>
      <Summary item={item} uiLang={uiLang} plugin={plugin} ctx={ctx} />
      <div class="cms-meta">
        {tagChips.map((c) => (
          <span key={c} class="cms-chip">
            {c}
          </span>
        ))}
        <span class="cms-chip" lang={item.lang}>
          {langLabel}
        </span>
        <span class="cms-date">{t(uiLang, 'card.submitted', { date })}</span>
        {demo && (
          <a class="cms-btn cms-demo" href={demo.href} target="_blank" rel="noopener noreferrer nofollow ugc">
            {platform ? t(uiLang, 'card.demo', { platform }) : t(uiLang, 'card.demoGeneric')}
          </a>
        )}
      </div>
      <Explanation html={item.explanationHtml} lang={item.lang} uiLang={uiLang} />
    </>
  )
}

function Summary({ item, uiLang, plugin, ctx }: { item: PublicItem; uiLang: Lang; plugin: PluginState; ctx: ReturnType<typeof makeCtx> }) {
  const ref = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  const ready = plugin.s === 'ready' ? plugin.plugin : null
  useEffect(() => {
    const el = ref.current
    if (!el || !ready) return
    let cleanup: (() => void) | undefined
    try {
      cleanup = ready.mountSummary(el, item.payload, ctx)
      setFailed(false)
    } catch (e) {
      console.warn('[wiki-cms] plugin mountSummary failed', e)
      setFailed(true)
    }
    return () => {
      try {
        cleanup?.()
      } catch {
        /* ignore plugin cleanup errors */
      }
      el.replaceChildren()
    }
  }, [ready, item.payload, ctx])

  if (plugin.s === 'failed' || failed) return <p class="cms-unavailable">{t(uiLang, 'card.detailsUnavailable')}</p>
  return <div class="cms-summary" ref={ref} aria-busy={plugin.s === 'loading'} />
}

function Explanation({ html, lang, uiLang }: { html: string; lang: Lang; uiLang: Lang }) {
  const ref = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflow, setOverflow] = useState(false)
  const measure = useCallback(() => {
    const el = ref.current
    if (el && !expanded) setOverflow(el.scrollHeight > el.clientHeight + 1)
  }, [expanded])
  useLayoutEffect(() => {
    measure()
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    // Also fires when a hidden ancestor (e.g. an inactive tab) becomes visible, and on width changes.
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure, html])
  const id = useMemo(() => `cms-x-${Math.random().toString(36).slice(2, 8)}`, [])
  return (
    <div class="cms-expl-wrap">
      <div
        ref={ref}
        id={id}
        class={`cms-expl${expanded ? ' cms-expanded' : ''}`}
        lang={lang}
        // Server-rendered with HTML disabled (src/shared/markdown-policy.ts).
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {(overflow || expanded) && (
        <button type="button" class="cms-link" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((x) => !x)}>
          {expanded ? t(uiLang, 'card.showLess') : t(uiLang, 'card.showFull')}
        </button>
      )}
    </div>
  )
}

/** Last line of defence: a render error never breaks the host page. */
class Boundary extends Component<{ host: HTMLElement; children: ComponentChildren }, { error: boolean }> {
  state = { error: false }
  componentDidCatch(e: unknown) {
    console.error('[wiki-cms] embed crashed', e)
    this.setState({ error: true })
  }
  render() {
    if (!this.state.error) return this.props.children
    const lang = resolveUiLang(this.props.host)
    return (
      <div class="cms-status" role="alert">
        <p>{t(lang, 'list.loadError')}</p>
        <button type="button" class="cms-btn" onClick={() => this.setState({ error: false })}>
          {t(lang, 'list.retry')}
        </button>
      </div>
    )
  }
}

export function mountList(el: HTMLElement, opts: ListOpts): () => void {
  injectStyle()
  el.classList.add('cms-submissions')
  el.replaceChildren()
  const root = document.createElement('div')
  root.className = 'cms-root'
  el.appendChild(root)
  render(
    <Boundary host={el}>
      <App host={el} opts={opts} />
    </Boundary>,
    root,
  )
  return () => render(null, root)
}
