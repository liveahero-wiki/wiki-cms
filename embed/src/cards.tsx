// Card pieces of the embed's list (split out of list.tsx).
import type { ComponentChildren } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { PublicBlob, PublicItem, TagDefDto } from '../../src/shared/api-types.ts'
import { pickText } from '../../src/shared/i18n.ts'
import type { SubmissionPlugin } from '../../src/shared/plugin-api.ts'
import { t } from './i18n/t.ts'
import { demoPlatform, parseHttps, type Lang, type makeCtx } from './shared.ts'

export type PluginState = { s: 'loading' } | { s: 'failed' } | { s: 'ready'; plugin: SubmissionPlugin }
export type Ctx = ReturnType<typeof makeCtx>

export function Chip({ active, onClick, children }: { active: boolean; onClick(): void; children: ComponentChildren }) {
  return (
    <button type="button" class={`cms-chip cms-chip-btn${active ? ' cms-active' : ''}`} aria-pressed={active} onClick={onClick}>
      {children}
    </button>
  )
}

export function Card({ item, blob, uiLang, plugin, ctx }: { item: PublicItem; blob: PublicBlob; uiLang: Lang; plugin: PluginState; ctx: Ctx }) {
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
      {blob.meta.title && (
        // User text, rendered as text only.
        <h3 class={`cms-card-title${item.title ? '' : ' cms-untitled'}`} lang={item.title ? item.lang : undefined}>
          {item.title || t(uiLang, 'card.untitled')}
        </h3>
      )}
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

function Summary({ item, uiLang, plugin, ctx }: { item: PublicItem; uiLang: Lang; plugin: PluginState; ctx: Ctx }) {
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

let explSeq = 0

/** Collapsed by default: the HTML is not rendered until the toggle is opened. */
function Explanation({ html, lang, uiLang }: { html: string; lang: Lang; uiLang: Lang }) {
  const [open, setOpen] = useState(false)
  const id = useMemo(() => `cms-x-${++explSeq}`, [])
  return (
    <div class="cms-expl-wrap">
      <button type="button" class="cms-link" aria-expanded={open} aria-controls={id} onClick={() => setOpen((x) => !x)}>
        {open ? t(uiLang, 'card.hideExplanation') : t(uiLang, 'card.showExplanation')}
      </button>
      <div id={id} class="cms-expl" lang={lang} hidden={!open}>
        {/* Server-rendered with HTML disabled (src/shared/markdown-policy.ts). */}
        {open && <div dangerouslySetInnerHTML={{ __html: html }} />}
      </div>
    </div>
  )
}
