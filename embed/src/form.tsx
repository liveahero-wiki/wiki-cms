import { render } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { ContribEditRequest, SubmitRequest, TypeConfig } from '../../src/shared/api-types.ts'
import { pickText } from '../../src/shared/i18n.ts'
import { MAX_LINKS } from '../../src/shared/link-policy.ts'
import { checkExplanation, renderExplanation } from '../../src/shared/markdown-policy.ts'
import { checkTitle, titleLength, normalizeTitle } from '../../src/shared/title-policy.ts'
import type { EditorHandle, FieldError, SubmissionPlugin } from '../../src/shared/plugin-api.ts'
import { apiErrorText, fieldErrorText, t } from './i18n/t.ts'
import { AccountBar, SignInGate } from './account.tsx'
import { createSubmission, editSubmission } from './contrib-api.ts'
import { currentSession, onSessionChange, type StoredSession } from './contrib-session.ts'
import type { EditTarget } from './form-api.ts'
import { ApiError, fetchConfig, injectStyle, loadPlugin, makeCtx, parseHttps, postSubmission, type Lang, type ListOpts } from './shared.ts'

export interface FormArgs {
  host: HTMLElement
  opts: ListOpts
  uiLang: Lang
  /** `groupOptions` of the list blob (passed to the plugin as ctx.group.options). */
  groupOptions: Record<string, unknown>
  /** Edit one of the signed-in contributor's own submissions (prefilled; the draft is kept per submission version). */
  edit?: EditTarget
  /** Called once when the dialog has been closed and removed. */
  onClose?: () => void
}

interface Values {
  payload: unknown
  /** '' when the type has no names. */
  title: string
  tags: Record<string, string>
  lang: Lang
  explanation: string
  demoUrl: string
}

// ---- Turnstile ----

interface TurnstileApi {
  render(el: HTMLElement, o: Record<string, unknown>): string
  reset(id?: string): void
  remove(id?: string): void
}
const TS_LANG: Record<Lang, string> = { en: 'en', 'zh-Hans': 'zh-cn', 'zh-Hant': 'zh-tw', ja: 'ja' }
const turnstileApi = () => (window as unknown as { turnstile?: TurnstileApi }).turnstile
let turnstileLoad: Promise<TurnstileApi> | undefined

function loadTurnstile(): Promise<TurnstileApi> {
  turnstileLoad ??= new Promise<TurnstileApi>((resolve, reject) => {
    const ready = turnstileApi()
    if (ready) return resolve(ready)
    const s = document.createElement('script')
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    s.async = true
    s.onload = () => (turnstileApi() ? resolve(turnstileApi()!) : reject(new Error('turnstile missing')))
    s.onerror = () => reject(new Error('turnstile failed to load'))
    document.head.appendChild(s)
  })
  turnstileLoad.catch(() => (turnstileLoad = undefined))
  return turnstileLoad
}

// ---- helpers ----

const stable = (v: unknown) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x))
const template = (cfg: TypeConfig, lang: Lang) => cfg.explanation!.template[lang] ?? cfg.explanation!.template.en
/** Tags the form preselects (a type's `default`; the server never fills them in). */
const tagDefaults = (cfg: TypeConfig): Record<string, string> =>
  Object.fromEntries(cfg.tags.flatMap((d) => (d.default !== undefined && d.options.some((o) => o.value === d.default) ? [[d.key, d.default]] : [])))
const isPayloadPath = (p: string) => p === 'payload' || p.startsWith('payload.')
const normPayloadPath = (p: string) => (isPayloadPath(p) ? p : p ? `payload.${p}` : 'payload')

function readDraft(key: string, cfg: TypeConfig): Values | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const d = JSON.parse(raw) as Partial<Values>
    if (!d || typeof d !== 'object' || d.payload === undefined) return null
    const lang = cfg.langs.some((l) => l.value === d.lang) ? (d.lang as Lang) : null
    if (!lang || typeof d.explanation !== 'string' || typeof d.demoUrl !== 'string') return null
    const tags: Record<string, string> = {}
    for (const def of cfg.tags) {
      const x = d.tags?.[def.key]
      if (typeof x === 'string' && def.options.some((o) => o.value === x)) tags[def.key] = x
    }
    // Keys the draft lacks (e.g. tags added after it was saved) get the type's defaults.
    return { payload: d.payload, title: typeof d.title === 'string' ? d.title : '', tags: { ...tagDefaults(cfg), ...tags }, lang, explanation: d.explanation, demoUrl: d.demoUrl }
  } catch {
    return null
  }
}

function writeDraft(key: string, v: Values | null) {
  try {
    if (v) localStorage.setItem(key, JSON.stringify(v))
    else localStorage.removeItem(key)
  } catch {
    /* storage unavailable (private mode, quota): drafts are a convenience only */
  }
}

/** Client-side mirror of the generic server rules (submission-validate.ts), minus the payload. */
function validateLocal(cfg: TypeConfig, v: Values): FieldError[] {
  const en = (code: string, params?: Record<string, string | number>) => ({
    code,
    message: fieldErrorText('en', { code, message: code, params }),
    params,
  })
  const errors: FieldError[] = []
  if (cfg.title) {
    // checkTitle's English messages are only a fallback; the form localizes from code/params.
    errors.push(...checkTitle(v.title, cfg.title).errors)
  }
  for (const def of cfg.tags) {
    if (def.required && !v.tags[def.key]) errors.push({ path: `tags.${def.key}`, ...en('tag_required') })
  }
  const expl = v.explanation.replace(/\r\n?/g, '\n').trim()
  if (!expl) errors.push({ path: 'explanation', ...en('explanation_required') })
  else if (expl.length > cfg.explanation!.maxLength) errors.push({ path: 'explanation', ...en('explanation_too_long', { max: cfg.explanation!.maxLength }) })
  else errors.push(...checkExplanation(expl))
  const demo = v.demoUrl.trim()
  if (!demo) {
    if (cfg.demoUrl!.required) errors.push({ path: 'demoUrl', ...en('demo_required') })
  } else if (demo.length > 300) errors.push({ path: 'demoUrl', ...en('demo_too_long') })
  else {
    let u: URL | null = null
    try {
      u = new URL(demo)
    } catch {
      errors.push({ path: 'demoUrl', ...en('demo_invalid') })
    }
    if (u) {
      if (u.protocol !== 'https:') errors.push({ path: 'demoUrl', ...en('demo_https') })
      else if (u.username || u.password || u.port) errors.push({ path: 'demoUrl', ...en('demo_invalid') })
      else if (!cfg.demoUrl!.allowedHosts.includes(u.hostname.toLowerCase())) errors.push({ path: 'demoUrl', ...en('demo_host') })
    }
  }
  return errors
}

// ---- small components ----

function Errors({ id, lang, errors }: { id: string; lang: Lang; errors: FieldError[] }) {
  if (!errors.length) return null
  return (
    <div id={id} class="cms-error">
      {errors.map((e, i) => (
        <p key={i}>{fieldErrorText(lang, e)}</p>
      ))}
    </div>
  )
}

function Req({ lang }: { lang: Lang }) {
  return <span class="cms-req">({t(lang, 'form.required')})</span>
}

function EditorMount({
  plugin,
  initial,
  ctx,
  onChange,
  onHandle,
}: {
  plugin: SubmissionPlugin
  initial: unknown
  ctx: ReturnType<typeof makeCtx>
  onChange(p: unknown): void
  onHandle(h: EditorHandle | null): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const latest = useRef(onChange)
  latest.current = onChange
  useEffect(() => {
    const el = ref.current!
    let handle: EditorHandle | undefined
    const emit = (p: unknown) => latest.current(p)
    try {
      handle = plugin.mountEditor(el, { value: initial, onChange: emit, errors: [] }, ctx)
    } catch (e) {
      // A stale draft payload may not suit the editor any more: fall back to the default payload.
      console.warn('[wiki-cms] editor rejected the stored draft', e)
      el.replaceChildren()
      const value = plugin.defaultPayload()
      handle = plugin.mountEditor(el, { value, onChange: emit, errors: [] }, ctx)
      emit(value)
    }
    onHandle(handle)
    return () => {
      try {
        handle?.destroy()
      } catch {
        /* ignore plugin cleanup errors */
      }
      onHandle(null)
      el.replaceChildren()
    }
  }, [])
  return <div ref={ref} class="cms-editor" data-field="payload" tabIndex={-1} />
}

// ---- form body ----

function FormBody({ cfg, plugin, args, session, close, setClose }: {
  cfg: TypeConfig
  plugin: SubmissionPlugin
  args: FormArgs
  /** Set when the type needs an account (or this is an edit). */
  session: StoredSession | null
  close(): void
  setClose(fn: () => void): void
}) {
  const { opts, uiLang: L, groupOptions, edit } = args
  // Edits keep their own draft per submission version, so a lost session (sign-in again remounts this body) or an
  // accidental close does not throw the work away; it is pristine (not stored) until something changes.
  const draftKey = edit ? `cms-draft-edit:${edit.id}:${edit.version}` : `cms-draft:${opts.type}:${opts.group}`
  const ctx = useMemo(() => makeCtx(opts, L, groupOptions), [])
  const defaultLang = (cfg.langs.some((l) => l.value === 'en') ? 'en' : cfg.langs[0]?.value ?? 'en') as Lang
  const fresh = useMemo<Values>(
    () =>
      edit
        ? { payload: edit.initial.payload, title: edit.initial.title, tags: { ...edit.initial.tags }, lang: edit.initial.lang, explanation: edit.initial.explanation, demoUrl: edit.initial.demoUrl }
        : { payload: plugin.defaultPayload(), title: '', tags: tagDefaults(cfg), lang: defaultLang, explanation: template(cfg, defaultLang), demoUrl: '' },
    [],
  )
  const restored = useMemo(() => readDraft(draftKey, cfg), [])
  const [v, setV] = useState<Values>(restored ?? fresh)
  const [draftNote, setDraftNote] = useState(restored !== null)
  const [editorKey, setEditorKey] = useState(0)
  const [errors, setErrors] = useState<FieldError[]>([])
  const [banner, setBanner] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<null | 'created' | 'edited' | 'revision'>(null)
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const [tsError, setTsError] = useState(false)

  const formRef = useRef<HTMLFormElement>(null)
  const editor = useRef<EditorHandle | null>(null)
  const tsEl = useRef<HTMLDivElement>(null)
  const tsId = useRef<string | undefined>(undefined)
  const token = useRef('')
  const honeypot = useRef<HTMLInputElement>(null)
  const vRef = useRef(v)
  vRef.current = v
  const doneRef = useRef(false)
  const freshKey = useMemo(() => stable({ ...fresh }), [])
  const isPristine = (x: Values) => stable(x) === freshKey

  // Esc / ✕ / Cancel: confirm when there is something to lose.
  const requestClose = () => {
    if (!doneRef.current && !isPristine(vRef.current) && !window.confirm(t(L, 'form.closeConfirm'))) return
    close()
  }
  useEffect(() => {
    // Braces matter: `setClose` returns the fn it stored, which useEffect would run as the unmount
    // cleanup, i.e. a second confirm() right after the dialog closed.
    setClose(requestClose)
  }, [])

  // Persist the unsent draft (debounced) and flush it when the dialog goes away.
  useEffect(() => {
    if (done) return
    const id = setTimeout(() => writeDraft(draftKey, isPristine(v) ? null : v), 400)
    return () => clearTimeout(id)
  }, [v, done])
  useEffect(
    () => () => {
      if (!doneRef.current) writeDraft(draftKey, isPristine(vRef.current) ? null : vRef.current)
    },
    [],
  )

  // Turnstile (script is loaded lazily, the first time the dialog opens).
  useEffect(() => {
    let dead = false
    let id: string | undefined
    loadTurnstile().then(
      (ts) => {
        if (dead || !tsEl.current) return
        id = tsId.current = ts.render(tsEl.current, {
          sitekey: cfg.turnstileSiteKey,
          action: 'submit',
          theme: 'auto',
          language: TS_LANG[L],
          callback: (tok: string) => (token.current = tok),
          'expired-callback': () => (token.current = ''),
          'error-callback': () => (token.current = ''),
        })
      },
      () => !dead && setTsError(true),
    )
    return () => {
      dead = true
      try {
        if (id) turnstileApi()?.remove(id)
      } catch {
        /* ignore */
      }
    }
  }, [])

  // Hand payload errors to the plugin editor whenever they change.
  const payloadErrors = useMemo(() => errors.filter((e) => isPayloadPath(e.path)), [errors])
  useEffect(() => {
    try {
      editor.current?.setErrors(payloadErrors)
    } catch (e) {
      console.warn('[wiki-cms] editor.setErrors failed', e)
    }
  }, [payloadErrors, editorKey])

  const clearErrors = (match: (path: string) => boolean) => setErrors((es) => (es.some((e) => match(e.path)) ? es.filter((e) => !match(e.path)) : es))
  const errFor = (path: string) => errors.filter((e) => e.path === path)
  // Errors whose path matches no control (e.g. a field a newer server added) still get shown, in the footer.
  const knownPaths = new Set(['title', 'lang', 'explanation', 'demoUrl', ...cfg.tags.map((d) => `tags.${d.key}`)])
  const otherErrors = errors.filter((e) => !isPayloadPath(e.path) && !knownPaths.has(e.path))

  const liveExpl = useMemo(() => (v.explanation.trim() ? checkExplanation(v.explanation) : []), [v.explanation])
  const explErrors = useMemo(() => {
    const seen = new Set<string>()
    return [...liveExpl, ...errFor('explanation')].filter((e) => {
      const text = fieldErrorText(L, e) // md_html and md_link share one message
      return !seen.has(text) && !!seen.add(text)
    })
  }, [liveExpl, errors])
  const previewHtml = useMemo(() => (tab === 'preview' ? renderExplanation(v.explanation) : ''), [tab, v.explanation])
  const explLen = v.explanation.trim().length
  const max = cfg.explanation!.maxLength

  const onLang = (lang: Lang) => {
    clearErrors((p) => p === 'lang')
    setV((x) => {
      const keep = x.explanation.trim() !== template(cfg, x.lang).trim()
      return { ...x, lang, explanation: keep ? x.explanation : template(cfg, lang) }
    })
  }

  // Focus the first invalid field once the errors are rendered (and handed to the plugin editor).
  const pendingFocus = useRef<FieldError[] | null>(null)
  useEffect(() => {
    const es = pendingFocus.current
    if (!es) return
    pendingFocus.current = null
    const has = (key: string) => es.some((e) => (key === 'payload' ? isPayloadPath(e.path) : e.path === key || e.path.startsWith(`${key}.`)))
    const first = [...(formRef.current?.querySelectorAll<HTMLElement>('[data-field]') ?? [])].find((el) => has(el.dataset.field!))
    if (!first) return
    const target =
      first.dataset.field === 'payload'
        ? (first.querySelector<HTMLElement>('[aria-invalid="true"]') ?? first)
        : first.matches('fieldset')
          ? (first.querySelector<HTMLElement>('input') ?? first)
          : first
    target.focus()
    target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [errors])

  const showErrors = (es: FieldError[], bannerText: string) => {
    pendingFocus.current = es
    if (es.some((e) => e.path === 'explanation')) setTab('write')
    setErrors(es)
    setBanner(bannerText)
  }

  const resetWidget = () => {
    token.current = ''
    try {
      turnstileApi()?.reset(tsId.current)
    } catch {
      /* ignore */
    }
  }

  const onSubmit = async (e: Event) => {
    e.preventDefault()
    if (busy) return
    setBanner(null)
    const es = validateLocal(cfg, v)
    try {
      for (const pe of editor.current?.validate() ?? []) es.push({ ...pe, path: normPayloadPath(pe.path) })
    } catch (err) {
      console.warn('[wiki-cms] editor.validate failed', err)
    }
    if (es.length) return showErrors(es, t(L, 'form.fixErrors'))
    if (!token.current) return setBanner(tsError ? t(L, 'form.verifyLoadError') : t(L, 'form.verifyMissing'))

    setBusy(true)
    const body: SubmitRequest = {
      payload: v.payload,
      ...(cfg.title ? { title: normalizeTitle(v.title) } : {}),
      tags: v.tags,
      lang: v.lang,
      explanation: v.explanation,
      demoUrl: v.demoUrl.trim(),
      turnstileToken: token.current,
      website: honeypot.current?.value ?? '',
    }
    let err: ApiError | null = null
    let outcome: 'created' | 'edited' | 'revision' = 'created'
    try {
      if (edit) {
        const r = await editSubmission(opts.api, edit.id, { ...body, expectedVersion: edit.version } satisfies ContribEditRequest)
        outcome = r.state === 'revision_pending' ? 'revision' : 'edited'
      } else if (session) {
        await createSubmission(opts.api, opts.type, opts.group, body)
      } else {
        err = await postSubmission(opts, body)
      }
    } catch (e) {
      err = e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e))
    }
    setBusy(false)
    if (!err) {
      doneRef.current = true
      writeDraft(draftKey, null)
      setDone(outcome)
      return
    }
    resetWidget() // tokens are single-use
    if (err.code === 'validation_failed' && err.fields?.length) {
      showErrors(err.fields, t(L, 'form.fixErrors'))
    } else {
      setBanner(apiErrorText(L, err.code, err.message))
    }
  }

  if (done !== null) {
    return (
      <>
        <div class="cms-dlg-body">
          <p class="cms-success" role="status">
            {t(L, done === 'revision' ? 'form.successRevision' : done === 'edited' ? 'form.successEdited' : 'form.success')}
          </p>
        </div>
        <div class="cms-dlg-foot">
          <button type="button" class="cms-btn cms-primary" onClick={close}>
            {t(L, 'form.done')}
          </button>
        </div>
      </>
    )
  }

  return (
    <form ref={formRef} class="cms-form" noValidate onSubmit={onSubmit}>
      <div class="cms-dlg-body">
        {session && <AccountBar api={opts.api} lang={L} session={session} />}
        {draftNote && (
          <p class="cms-note" role="status">
            {t(L, 'form.draftRestored')}{' '}
            <button
              type="button"
              class="cms-link"
              onClick={() => {
                writeDraft(draftKey, null)
                setV(fresh)
                setErrors([])
                setBanner(null)
                setDraftNote(false)
                setEditorKey((k) => k + 1)
              }}
            >
              {t(L, 'form.startOver')}
            </button>
          </p>
        )}

        {cfg.title && (
          <div class="cms-field">
            <div class="cms-label-row">
              <label class="cms-label" for="cms-title">
                {pickText(cfg.title.label, L)} {cfg.title.required && <Req lang={L} />}
              </label>
              <span class={`cms-counter${titleLength(normalizeTitle(v.title)) > cfg.title.maxLength ? ' cms-over' : ''}`} id="cms-title-count">
                {titleLength(normalizeTitle(v.title))} / {cfg.title.maxLength}
              </span>
            </div>
            <input
              key={v.lang}
              id="cms-title"
              class="cms-input"
              data-field="title"
              type="text"
              lang={v.lang}
              spellcheck
              autocomplete="off"
              maxLength={cfg.title.maxLength * 2}
              placeholder={cfg.title.placeholder ? pickText(cfg.title.placeholder, L) : undefined}
              value={v.title}
              aria-describedby="cms-title-hint cms-title-err cms-title-count"
              aria-invalid={errFor('title').length ? true : undefined}
              onInput={(e) => {
                const title = (e.currentTarget as HTMLInputElement).value
                clearErrors((p) => p === 'title')
                setV((x) => ({ ...x, title }))
              }}
            />
            <p class="cms-hint" id="cms-title-hint">
              {t(L, 'form.titleHint', { min: cfg.title.minLength, max: cfg.title.maxLength })}
            </p>
            <Errors id="cms-title-err" lang={L} errors={errFor('title')} />
          </div>
        )}

        <div class="cms-field" role="group" aria-labelledby="cms-f-team">
          <div class="cms-label" id="cms-f-team">
            {t(L, 'form.team')} <Req lang={L} />
          </div>
          <EditorMount
            key={editorKey}
            plugin={plugin}
            initial={v.payload}
            ctx={ctx}
            onChange={(p) => {
              setV((x) => ({ ...x, payload: p }))
              clearErrors(isPayloadPath)
            }}
            onHandle={(h) => (editor.current = h)}
          />
        </div>

        {cfg.tags.map((def) => {
          const id = `cms-tag-${def.key}`
          const errs = errFor(`tags.${def.key}`)
          return (
            <fieldset key={def.key} class="cms-field" data-field={`tags.${def.key}`} aria-describedby={errs.length ? `${id}-err` : undefined}>
              <legend class="cms-label">
                {pickText(def.label, L)} {def.required && <Req lang={L} />}
              </legend>
              <div class="cms-radios">
                {(def.required ? def.options : [{ value: '', label: { en: t(L, 'form.tagNone') } }, ...def.options]).map((o) => (
                  <label key={o.value} class="cms-radio">
                    <input
                      type="radio"
                      name={id}
                      value={o.value}
                      checked={(v.tags[def.key] ?? '') === o.value}
                      aria-invalid={errs.length ? true : undefined}
                      onChange={() => {
                        clearErrors((p) => p === `tags.${def.key}`)
                        setV((x) => {
                          const tags = { ...x.tags }
                          if (o.value) tags[def.key] = o.value
                          else delete tags[def.key]
                          return { ...x, tags }
                        })
                      }}
                    />
                    <span>{pickText(o.label, L)}</span>
                  </label>
                ))}
              </div>
              <Errors id={`${id}-err`} lang={L} errors={errs} />
            </fieldset>
          )
        })}

        <div class="cms-field">
          <label class="cms-label" for="cms-lang">
            {t(L, 'form.lang')}
          </label>
          <select
            id="cms-lang"
            class="cms-input"
            data-field="lang"
            value={v.lang}
            aria-describedby="cms-lang-hint cms-lang-err"
            aria-invalid={errFor('lang').length ? true : undefined}
            onChange={(e) => onLang((e.currentTarget as HTMLSelectElement).value as Lang)}
          >
            {cfg.langs.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
          <p class="cms-hint" id="cms-lang-hint">
            {t(L, 'form.langHint')}
          </p>
          <Errors id="cms-lang-err" lang={L} errors={errFor('lang')} />
        </div>

        <div class="cms-field">
          <div class="cms-label-row">
            <label class="cms-label" for="cms-expl">
              {t(L, 'form.explanation')} <Req lang={L} />
            </label>
            <div class="cms-tabs" role="tablist" onKeyDown={(e) => (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && setTab((x) => (x === 'write' ? 'preview' : 'write'))}>
              {(['write', 'preview'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  class={`cms-tab${tab === k ? ' cms-active' : ''}`}
                  aria-selected={tab === k}
                  tabIndex={tab === k ? 0 : -1}
                  onClick={() => setTab(k)}
                >
                  {t(L, k === 'write' ? 'form.write' : 'form.preview')}
                </button>
              ))}
            </div>
          </div>
          {tab === 'write' ? (
            <textarea
              key={v.lang}
              id="cms-expl"
              class="cms-input cms-textarea"
              data-field="explanation"
              rows={14}
              lang={v.lang}
              value={v.explanation}
              spellcheck
              aria-describedby="cms-expl-hint cms-expl-err cms-expl-count"
              aria-invalid={explErrors.length ? true : undefined}
              onInput={(e) => {
                const explanation = (e.currentTarget as HTMLTextAreaElement).value
                clearErrors((p) => p === 'explanation')
                setV((x) => ({ ...x, explanation }))
              }}
            />
          ) : (
            <div id="cms-expl" class="cms-input cms-preview cms-expl cms-expanded" lang={v.lang} role="tabpanel">
              {v.explanation.trim() ? <div dangerouslySetInnerHTML={{ __html: previewHtml }} /> : <p class="cms-hint">{t(L, 'form.previewEmpty')}</p>}
            </div>
          )}
          <div class="cms-under">
            <p class="cms-hint" id="cms-expl-hint">
              {t(L, 'form.markdownHint', { max: MAX_LINKS })}
            </p>
            <span id="cms-expl-count" class={`cms-counter${explLen > max ? ' cms-over' : ''}`}>
              {explLen} / {max}
            </span>
          </div>
          <Errors id="cms-expl-err" lang={L} errors={explErrors} />
        </div>

        <div class="cms-field">
          <label class="cms-label" for="cms-demo">
            {t(L, 'form.demo')} {cfg.demoUrl!.required && <Req lang={L} />}
          </label>
          <input
            id="cms-demo"
            class="cms-input"
            data-field="demoUrl"
            type="url"
            inputMode="url"
            autocomplete="off"
            placeholder="https://"
            value={v.demoUrl}
            aria-describedby="cms-demo-hint cms-demo-err"
            aria-invalid={errFor('demoUrl').length ? true : undefined}
            onInput={(e) => {
              const demoUrl = (e.currentTarget as HTMLInputElement).value
              clearErrors((p) => p === 'demoUrl')
              setV((x) => ({ ...x, demoUrl }))
            }}
          />
          <p class="cms-hint" id="cms-demo-hint">
            {t(L, 'form.demoHint')}
          </p>
          <Errors id="cms-demo-err" lang={L} errors={errFor('demoUrl')} />
        </div>

        {/* Honeypot: real users never see or fill this. */}
        <div class="cms-hp" aria-hidden="true">
          <input ref={honeypot} type="text" name="website" tabIndex={-1} autocomplete="off" />
        </div>

        <div class="cms-field">
          <div ref={tsEl} class="cms-ts" role="group" aria-label={t(L, 'form.verification')} />
          {tsError && <p class="cms-error">{t(L, 'form.verifyLoadError')}</p>}
        </div>

        <p class="cms-hint">{t(L, 'form.privacy')}</p>
      </div>

      <div class="cms-dlg-foot">
        <div class="cms-live" aria-live="polite">
          {busy && t(L, 'form.submitting')}
        </div>
        {banner && (
          <div class="cms-banner" role="alert">
            <p>{banner}</p>
            {otherErrors.map((e, i) => (
              <p key={i}>{fieldErrorText(L, e)}</p>
            ))}
          </div>
        )}
        <div class="cms-actions">
          <button type="button" class="cms-btn" onClick={requestClose}>
            {t(L, 'form.cancel')}
          </button>
          <button type="submit" class="cms-btn cms-primary" disabled={busy}>
            {busy ? t(L, 'form.submitting') : t(L, edit ? 'form.submitEdit' : 'form.submit')}
          </button>
        </div>
      </div>
    </form>
  )
}

// ---- dialog shell ----

function Shell({ args, dialog, dispose }: { args: FormArgs; dialog: HTMLDialogElement; dispose(): void }) {
  const L = args.uiLang
  const [cfg, setCfg] = useState<TypeConfig | null>(null)
  const [plugin, setPlugin] = useState<SubmissionPlugin | null>(null)
  const [failure, setFailure] = useState<'config' | 'plugin' | null>(null)
  const plainClose = () => {
    dialog.close()
    setTimeout(dispose, 0) // do not rely on the 'close' event alone
  }
  const closeFn = useRef<() => void>(plainClose)
  const [session, setSession] = useState<StoredSession | null>(() => currentSession(args.opts.api))
  useEffect(() => onSessionChange(args.opts.api, () => setSession(currentSession(args.opts.api))), [])

  useEffect(() => {
    let dead = false
    Promise.allSettled([fetchConfig(args.opts), loadPlugin(args.opts.plugin)]).then(([c, p]) => {
      if (dead) return
      if (c.status === 'rejected') {
        console.warn('[wiki-cms] could not load the type config', c.reason)
        return setFailure('config')
      }
      if (p.status === 'rejected') {
        console.warn('[wiki-cms] plugin unavailable', p.reason)
        return setFailure('plugin')
      }
      setCfg(c.value)
      setPlugin(p.value)
    })
    return () => {
      dead = true
    }
  }, [])

  useEffect(() => {
    // Esc: ask first when there is unsent work (handled by the body through closeFn).
    const onCancel = (e: Event) => {
      e.preventDefault()
      closeFn.current()
    }
    dialog.addEventListener('cancel', onCancel)
    return () => dialog.removeEventListener('cancel', onCancel)
  }, [])

  return (
    <>
      <div class="cms-dlg-head">
        <h2 class="cms-dlg-title" id="cms-dlg-title">
          {t(L, args.edit ? 'form.titleEdit' : 'form.title')}
        </h2>
        <button type="button" class="cms-x" aria-label={t(L, 'form.close')} onClick={() => closeFn.current()}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      {cfg && plugin ? (
        // Edits always need the account; new submissions only when the type requires one. A signed-in contributor
        // always submits through the account (so the row is theirs), even while the type still allows anonymous posts.
        (args.edit || cfg.submitAuth === 'account') && !session ? (
          <SignInGate api={args.opts.api} lang={L} onCancel={plainClose} />
        ) : (
          <FormBody
            key={session?.user.id ?? 'anon'}
            cfg={cfg}
            plugin={plugin}
            args={args}
            session={session}
            close={plainClose}
            setClose={(fn) => (closeFn.current = fn)}
          />
        )
      ) : (
        <>
          <div class="cms-dlg-body">
            {failure ? (
              <p class="cms-error" role="alert">
                {t(L, failure === 'config' ? 'form.loadError' : 'form.editorUnavailable')}
              </p>
            ) : (
              <p class="cms-hint" role="status">
                {t(L, 'form.loading')}
              </p>
            )}
          </div>
          <div class="cms-dlg-foot">
            <div class="cms-actions">
              <button type="button" class="cms-btn" onClick={plainClose}>
                {t(L, 'form.close')}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  )
}

export function openForm(args: FormArgs): void {
  const { host } = args
  const stale = host.querySelector<HTMLDialogElement>(':scope > dialog.cms-dialog')
  if (stale?.open) return
  if (stale) {
    // A browser can close a dialog without firing 'close' (e.g. a repeated Esc): drop the leftovers.
    render(null, stale)
    stale.remove()
  }
  injectStyle()
  const dialog = document.createElement('dialog')
  dialog.className = 'cms-dialog'
  dialog.setAttribute('aria-labelledby', 'cms-dlg-title')
  // Inside the host element so the theme variables inherit.
  host.appendChild(dialog)
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    render(null, dialog)
    dialog.remove()
    try {
      args.onClose?.()
    } catch (e) {
      console.warn('[wiki-cms] openForm onClose threw', e)
    }
  }
  dialog.addEventListener('close', dispose, { once: true })
  render(<Shell args={args} dialog={dialog} dispose={dispose} />, dialog)
  dialog.showModal()
}
