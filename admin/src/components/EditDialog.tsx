import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { AdminSubmission, EditSubmissionRequest, ModerationResponse } from '../../../src/shared/api-types.ts'
import type { Lang } from '../../../src/shared/i18n.ts'
import type { EditorHandle, FieldError, PluginContext, SubmissionPlugin } from '../../../src/shared/plugin-api.ts'
import { ApiError, api, errorMessage } from '../api.ts'
import { loadMarkdownPolicy } from '../markdown.ts'
import { useTheme } from '../theme.ts'
import { useTypeData } from '../typeData.tsx'
import { Dialog, Notice } from './ui.tsx'

type Policy = Awaited<ReturnType<typeof loadMarkdownPolicy>>

const isPayloadPath = (p: string) => p === 'payload' || p.startsWith('payload.')

interface EditorMountProps {
  plugin: SubmissionPlugin
  ctx: PluginContext
  getValue: () => unknown
  onChange: (p: unknown) => void
  errors: FieldError[]
  handleRef: { current: EditorHandle | null }
  onFail: (message: string) => void
}

/** Mounts the plugin editor; re-mounts (keeping the current value) when the group's options change. */
function EditorMount({ plugin, ctx, getValue, onChange, errors, handleRef, onFail }: EditorMountProps) {
  const ref = useRef<HTMLDivElement>(null)
  const errorsRef = useRef(errors)
  errorsRef.current = errors
  const cbRef = useRef({ onChange, onFail, ctx, getValue })
  cbRef.current = { onChange, onFail, ctx, getValue }
  const groupKey = JSON.stringify(ctx.group)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let handle: EditorHandle
    try {
      handle = plugin.mountEditor(
        el,
        { value: cbRef.current.getValue(), onChange: (p) => cbRef.current.onChange(p), errors: errorsRef.current },
        cbRef.current.ctx,
      )
    } catch (e) {
      cbRef.current.onFail(errorMessage(e))
      return
    }
    handleRef.current = handle
    return () => {
      try {
        handle.destroy()
      } catch {
        /* ignore */
      }
      if (handleRef.current === handle) handleRef.current = null
      el.replaceChildren()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin, groupKey])

  useEffect(() => {
    try {
      handleRef.current?.setErrors(errors)
    } catch {
      /* ignore */
    }
  }, [errors])

  return <div class="plugin-editor" ref={ref} />
}

/** Fallback editor used when the plugin cannot be loaded: raw JSON. */
function JsonEditor({ value, onChange, onValidity }: { value: unknown; onChange: (v: unknown) => void; onValidity: (ok: boolean) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2))
  const [bad, setBad] = useState(false)
  return (
    <>
      <textarea
        class="input input-mono"
        rows={12}
        spellcheck={false}
        value={text}
        aria-label="Payload (JSON)"
        aria-invalid={bad || undefined}
        onInput={(e) => {
          const t = e.currentTarget.value
          setText(t)
          try {
            onChange(JSON.parse(t))
            setBad(false)
            onValidity(true)
          } catch {
            setBad(true)
            onValidity(false)
          }
        }}
      />
      {bad && <p class="field-error">Not valid JSON.</p>}
    </>
  )
}

function FieldErrors({ id, errors }: { id: string; errors: { message: string }[] }) {
  if (errors.length === 0) return null
  return (
    <ul class="field-errors" id={id}>
      {errors.map((e, i) => (
        <li key={i} class="field-error">
          {e.message}
        </li>
      ))}
    </ul>
  )
}

interface Props {
  item: AdminSubmission
  onClose: () => void
  onSaved: (r: ModerationResponse) => void
  /** Reload the submission after a version conflict (parent re-fetches and closes the dialog). */
  onConflictReload: () => void | Promise<void>
}

export function EditDialog({ item, onClose, onSaved, onConflictReload }: Props) {
  const td = useTypeData()
  const { resolved } = useTheme()
  const config = td.config
  const form = useRef<HTMLFormElement>(null)

  const [groupId, setGroupId] = useState(item.groupId)
  const [lang, setLang] = useState<Lang>(item.lang)
  const [tags, setTags] = useState<Record<string, string>>(item.tags)
  const [explanation, setExplanation] = useState(item.explanation)
  const [demoUrl, setDemoUrl] = useState(item.demoUrl)
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const [policy, setPolicy] = useState<Policy | null>(null)

  const payloadRef = useRef<unknown>(item.payload)
  const [payloadDirty, setPayloadDirty] = useState(false)
  const [jsonValid, setJsonValid] = useState(true)
  const [editorFailed, setEditorFailed] = useState<string | null>(null)
  const handleRef = useRef<EditorHandle | null>(null)

  const [errors, setErrors] = useState<FieldError[]>([])
  const [general, setGeneral] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let live = true
    loadMarkdownPolicy().then((m) => live && setPolicy(m), () => {})
    return () => {
      live = false
    }
  }, [])

  const groups = useMemo(() => {
    const list = [...(td.groups ?? [])].sort((a, b) => a.title.localeCompare(b.title))
    if (!list.some((g) => g.groupId === item.groupId)) list.unshift({ groupId: item.groupId, title: item.groupId, url: null, options: {}, inRegistry: false, pending: 0, approved: 0, spam: 0, latestAt: null })
    return list
  }, [td.groups, item.groupId])
  const chosen = groups.find((g) => g.groupId === groupId)
  const ctx: PluginContext = { uiLang: 'en', theme: resolved, group: { id: groupId, options: chosen?.options ?? {} } }

  const normalized = explanation.replace(/\r\n?/g, '\n').trim()
  const max = config?.explanation.maxLength ?? 5000
  const mdErrors = useMemo(() => (policy && normalized ? policy.checkExplanation(normalized) : []), [policy, normalized])
  const previewHtml = useMemo(() => (policy && tab === 'preview' ? policy.renderExplanation(normalized) : ''), [policy, tab, normalized])

  const dirty =
    groupId !== item.groupId ||
    lang !== item.lang ||
    explanation !== item.explanation ||
    demoUrl !== item.demoUrl ||
    JSON.stringify(tags) !== JSON.stringify(item.tags) ||
    payloadDirty

  const byPath = (p: string) => errors.filter((e) => e.path === p)
  const payloadErrors = useMemo(() => errors.filter((e) => isPayloadPath(e.path)), [errors])
  const known = (p: string) => isPayloadPath(p) || p === 'lang' || p === 'explanation' || p === 'demoUrl' || p.startsWith('tags.')
  const otherErrors = errors.filter((e) => !known(e.path))

  // Move focus to the first invalid control after a failed save.
  useEffect(() => {
    if (errors.length) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [errors])

  async function save(e: Event) {
    e.preventDefault()
    setGeneral(null)
    const local: FieldError[] = []
    if (!normalized) local.push({ path: 'explanation', code: 'explanation_required', message: 'An explanation is required.' })
    else if (normalized.length > max) local.push({ path: 'explanation', code: 'explanation_too_long', message: `The explanation must be at most ${max} characters.` })
    else local.push(...mdErrors)
    if (editorFailed && !jsonValid) local.push({ path: 'payload', code: 'payload_invalid', message: 'The payload is not valid JSON.' })
    if (!editorFailed && handleRef.current) {
      try {
        local.push(...handleRef.current.validate())
      } catch (err) {
        setGeneral(`The editor failed to validate: ${errorMessage(err)}`)
        return
      }
    }
    if (local.length) {
      setErrors(local)
      return
    }
    const body: EditSubmissionRequest = { expectedVersion: item.version }
    if (groupId !== item.groupId) body.groupId = groupId
    if (lang !== item.lang) body.lang = lang
    if (JSON.stringify(tags) !== JSON.stringify(item.tags)) body.tags = tags
    if (explanation !== item.explanation) body.explanation = explanation
    if (demoUrl !== item.demoUrl) body.demoUrl = demoUrl.trim()
    if (payloadDirty) body.payload = payloadRef.current
    if (Object.keys(body).length === 1) {
      onClose()
      return
    }
    setSaving(true)
    setErrors([])
    try {
      onSaved(await api.patch<ModerationResponse>(`/submissions/${encodeURIComponent(item.id)}`, body))
    } catch (err) {
      if (err instanceof ApiError && err.code === 'version_conflict') setConflict(true)
      else if (err instanceof ApiError && err.code === 'validation_failed' && err.fields.length) setErrors(err.fields)
      else setGeneral(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const tabKeys = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const next = tab === 'write' ? 'preview' : 'write'
      setTab(next)
      document.getElementById(`edit-tab-${next}`)?.focus()
    }
  }

  return (
    <Dialog title="Edit submission" wide onClose={onClose} canClose={() => saving === false && (!dirty || confirm('Discard your changes?'))} labelId="edit-title">
      <form class="form" ref={form} onSubmit={save} noValidate>
        {conflict ? (
          <div class="notice notice-warn" role="alert">
            <span>Someone else changed this submission. Reload it to see the latest version; your edits here will be lost.</span>
            <button type="button" class="btn btn-small" onClick={() => onConflictReload()}>
              Reload
            </button>
          </div>
        ) : null}
        {general && <Notice kind="error">{general}</Notice>}
        {otherErrors.length > 0 && (
          <Notice kind="error">
            <ul class="plain-list">
              {otherErrors.map((e, i) => (
                <li key={i}>{e.message}</li>
              ))}
            </ul>
          </Notice>
        )}

        <label class="field">
          <span class="field-label">Group</span>
          <select class="input" value={groupId} onChange={(e) => setGroupId(e.currentTarget.value)} disabled={saving}>
            {groups.map((g) => (
              <option key={g.groupId} value={g.groupId}>
                {g.title === g.groupId ? g.groupId : `${g.title} (${g.groupId})`}
              </option>
            ))}
          </select>
          {groupId !== item.groupId && <span class="hint">Moving groups: the team formation is validated against the new group&apos;s rules (for example the support slot).</span>}
        </label>

        <div class="field-row">
          <label class="field">
            <span class="field-label">Language</span>
            <select class="input" value={lang} onChange={(e) => setLang(e.currentTarget.value as Lang)} disabled={saving} aria-invalid={byPath('lang').length > 0 || undefined}>
              {(config?.langs ?? [{ value: item.lang, label: item.lang }]).map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
            <FieldErrors id="err-lang" errors={byPath('lang')} />
          </label>
        </div>

        {config?.tags.map((def) => {
          const errs = byPath(`tags.${def.key}`)
          return (
            <fieldset class="field fieldset" key={def.key} aria-invalid={errs.length > 0 || undefined} aria-describedby={`err-tag-${def.key}`}>
              <legend class="field-label">{def.label.en}</legend>
              <div class="radio-row">
                {def.options.map((o, i) => (
                  <label class="check" key={o.value}>
                    <input
                      type="radio"
                      name={`tag-${def.key}`}
                      value={o.value}
                      checked={tags[def.key] === o.value}
                      aria-invalid={(errs.length > 0 && i === 0) || undefined}
                      onChange={() => setTags((t) => ({ ...t, [def.key]: o.value }))}
                      disabled={saving}
                    />
                    <span>{o.label.en}</span>
                  </label>
                ))}
              </div>
              <FieldErrors id={`err-tag-${def.key}`} errors={errs} />
            </fieldset>
          )
        })}

        <div class="field">
          <div class="field-top">
            <span class="field-label" id="expl-label">
              Explanation
            </span>
            <div class="mini-tabs" role="tablist" aria-label="Explanation mode">
              {(['write', 'preview'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  id={`edit-tab-${t}`}
                  class="mini-tab"
                  aria-selected={tab === t}
                  aria-controls="expl-panel"
                  tabIndex={tab === t ? 0 : -1}
                  onClick={() => setTab(t)}
                  onKeyDown={tabKeys}
                >
                  {t === 'write' ? 'Write' : 'Preview'}
                </button>
              ))}
            </div>
          </div>
          <div id="expl-panel" role="tabpanel" aria-labelledby={`edit-tab-${tab}`}>
            {tab === 'write' ? (
              <textarea
                class="input input-mono"
                rows={12}
                value={explanation}
                aria-labelledby="expl-label"
                aria-describedby="expl-count err-expl"
                aria-invalid={byPath('explanation').length > 0 || mdErrors.length > 0 || normalized.length > max || undefined}
                onInput={(e) => setExplanation(e.currentTarget.value)}
                disabled={saving}
              />
            ) : (
              <div class="prose preview" dangerouslySetInnerHTML={{ __html: previewHtml || '<p class="hint">Nothing to preview.</p>' }} />
            )}
          </div>
          <div class="field-foot">
            <span id="expl-count" class={normalized.length > max ? 'count count-over' : 'count'}>
              {normalized.length} / {max}
            </span>
          </div>
          <FieldErrors id="err-expl" errors={[...byPath('explanation'), ...mdErrors.filter((m) => !byPath('explanation').some((s) => s.code === m.code))]} />
        </div>

        <label class="field">
          <span class="field-label">Demo URL</span>
          <input
            class="input"
            type="url"
            value={demoUrl}
            onInput={(e) => setDemoUrl(e.currentTarget.value)}
            disabled={saving}
            aria-invalid={byPath('demoUrl').length > 0 || undefined}
            aria-describedby="err-demo"
          />
          {config && <span class="hint">Allowed hosts: {config.demoUrl.allowedHosts.join(', ')}</span>}
          <FieldErrors id="err-demo" errors={byPath('demoUrl')} />
        </label>

        <div class="field">
          <span class="field-label">Team formation</span>
          {td.plugin.status === 'ready' && !editorFailed ? (
            <EditorMount
              plugin={td.plugin.plugin}
              ctx={ctx}
              getValue={() => payloadRef.current}
              onChange={(p) => {
                payloadRef.current = p
                setPayloadDirty(true)
              }}
              errors={payloadErrors}
              handleRef={handleRef}
              onFail={setEditorFailed}
            />
          ) : td.plugin.status === 'loading' ? (
            <p class="hint">Loading the plugin…</p>
          ) : (
            <>
              <p class="raw-warning">Plugin editor unavailable ({editorFailed ?? (td.plugin.status === 'failed' ? td.plugin.error : '')}); edit the raw JSON payload instead.</p>
              <JsonEditor
                value={payloadRef.current}
                onChange={(p) => {
                  payloadRef.current = p
                  setPayloadDirty(true)
                }}
                onValidity={setJsonValid}
              />
              <FieldErrors id="err-payload" errors={payloadErrors} />
            </>
          )}
        </div>

        <div class="dialog-actions">
          <button type="button" class="btn" onClick={() => (!dirty || confirm('Discard your changes?')) && onClose()} disabled={saving}>
            Cancel
          </button>
          <button type="submit" class="btn btn-primary" disabled={saving || conflict}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
