import { useEffect, useMemo, useState } from 'preact/hooks'
import type { AdminSubmission, ModerationResponse, SubmissionState } from '../../../src/shared/api-types.ts'
import type { PluginContext } from '../../../src/shared/plugin-api.ts'
import { ApiError, api, errorMessage } from '../api.ts'
import { flagEmoji, formatAbsolute, formatRelative } from '../format.ts'
import { loadMarkdownPolicy } from '../markdown.ts'
import { Link, groupPath } from '../router.tsx'
import { useTheme } from '../theme.ts'
import { toast } from '../toast.tsx'
import { groupOf, groupTitle, langLabel, tagLabels, useTypeData, type TypeData } from '../typeData.tsx'
import { BlockIpDialog } from './BlockIpDialog.tsx'
import { PluginView, RawPayload } from './PluginView.tsx'
import { Badge, Skeleton } from './ui.tsx'

export function usePluginCtx(td: TypeData, groupId: string): PluginContext {
  const { resolved } = useTheme()
  return { uiLang: 'en', theme: resolved, group: { id: groupId, options: groupOf(td, groupId)?.options ?? {} } }
}

function PayloadView({ kind, payload, groupId }: { kind: 'summary' | 'detail'; payload: unknown; groupId: string }) {
  const td = useTypeData()
  const ctx = usePluginCtx(td, groupId)
  if (td.plugin.status === 'loading') return <Skeleton lines={2} height="1.6em" />
  if (td.plugin.status === 'failed') return <RawPayload payload={payload} />
  return <PluginView kind={kind} plugin={td.plugin.plugin} payload={payload} ctx={ctx} />
}

/** Full destinations of the external links in a rendered explanation (the badge only shows the host). */
function externalLinks(html: string): string[] {
  if (!html.includes('cms-ext')) return []
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return [...doc.querySelectorAll<HTMLAnchorElement>('a.cms-ext')].map((a) => a.getAttribute('href') ?? '')
}

function Explanation({ html }: { html: string }) {
  // Safe: the Worker rendered it with raw HTML and images disabled; only validated https links get an <a>.
  const links = useMemo(() => externalLinks(html), [html])
  return (
    <>
      <div class="prose" dangerouslySetInnerHTML={{ __html: html }} />
      {links.length > 0 && (
        <div class="ext-links" role="note">
          <strong>External links ({links.length}) — check before approving:</strong>
          <ul>
            {links.map((href, i) => (
              <li key={i}>
                <code>{href}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}

function OriginalPanel({ original }: { original: NonNullable<AdminSubmission['original']> }) {
  const td = useTypeData()
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    loadMarkdownPolicy().then(
      (m) => live && setHtml(m.renderExplanation(original.explanation)),
      () => live && setHtml(null),
    )
    return () => {
      live = false
    }
  }, [original.explanation])
  const tags = tagLabels(td.config, original.tags)
  return (
    <section class="original" aria-label="Original submission">
      <h4>Original (as submitted)</h4>
      {td.config?.title && <p class="card-title">{original.title ? original.title : <span class="hint">Untitled</span>}</p>}
      <PayloadView kind="summary" payload={original.payload} groupId={original.groupId} />
      <p class="meta-line">
        <span>Group: {groupTitle(td, original.groupId)}</span>
        <span>Language: {langLabel(td.config, original.lang)}</span>
        {tags.map((t) => (
          <span key={t.key}>
            {t.label}: {t.value}
          </span>
        ))}
      </p>
      <p class="meta-line">
        <span>Demo: {original.demoUrl}</span>
      </p>
      {html !== null ? <Explanation html={html} /> : <pre class="raw-json">{original.explanation}</pre>}
    </section>
  )
}

const STATE_BADGE = { pending: 'warn', approved: 'ok', spam: 'danger' } as const

interface Props {
  item: AdminSubmission
  /** State of the tab the list is showing; a card whose state differs is shown as "moved". */
  listState?: SubmissionState
  /** Group the list is scoped to (unset in the cross-group queue). */
  listGroup?: string
  showGroup?: boolean
  onUpdate: (item: AdminSubmission) => void
  onBlocked?: () => void
}

export function SubmissionCard({ item, listState, listGroup, showGroup, onUpdate, onBlocked }: Props) {
  const td = useTypeData()
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [detail, setDetail] = useState(false)
  const [showExplanation, setShowExplanation] = useState(false)
  const [showOriginal, setShowOriginal] = useState(false)
  const [Edit, setEdit] = useState<typeof import('./EditDialog.tsx').EditDialog | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [blockOpen, setBlockOpen] = useState(false)

  const tags = tagLabels(td.config, item.tags)
  const edited = item.original !== null
  const movedState = listState !== undefined && item.state !== listState
  const movedGroup = listGroup !== undefined && item.groupId !== listGroup
  const moved = movedState || movedGroup
  const demoOk = /^https?:\/\//i.test(item.demoUrl)

  async function changeState(state: SubmissionState) {
    setBusy(true)
    setConflict(false)
    try {
      const r = await api.post<ModerationResponse>(`/submissions/${encodeURIComponent(item.id)}/state`, { expectedVersion: item.version, state })
      onUpdate(r.item)
      if (r.purgeWarning) toast(r.purgeWarning, 'warn')
      td.reloadGroups()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'version_conflict') setConflict(true)
      else toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function reload() {
    setBusy(true)
    try {
      onUpdate(await api.get<AdminSubmission>(`/submissions/${encodeURIComponent(item.id)}`))
      setConflict(false)
      td.reloadGroups()
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function openEdit() {
    setEditOpen(true)
    if (!Edit) {
      try {
        const m = await import('./EditDialog.tsx')
        setEdit(() => m.EditDialog)
      } catch {
        setEditOpen(false)
        toast('Could not load the editor. Reload the page and try again.', 'error')
      }
    }
  }

  const actions: { state: SubmissionState; label: string; cls: string }[] = [
    { state: 'approved', label: 'Approve', cls: 'btn-ok' },
    { state: 'spam', label: 'Mark spam', cls: 'btn-danger' },
    { state: 'pending', label: 'Back to pending', cls: '' },
  ]

  return (
    <article class={`card${moved ? ' card-moved' : ''}`} aria-label={`Submission ${item.id.slice(0, 8)}`} data-state={item.state}>
      <header class="card-head">
        <Badge kind={STATE_BADGE[item.state]}>{item.state}</Badge>
        {edited && (
          <Badge kind="accent" title="A moderator edited this submission">
            edited
          </Badge>
        )}
        {item.aiVerdict && (
          <Badge kind={item.aiVerdict === 'spam' ? 'danger' : 'neutral'} title={item.aiReason ?? undefined}>
            AI: {item.aiVerdict}
          </Badge>
        )}
        {showGroup && (
          <Link class="card-group" href={groupPath(item.type, item.groupId)}>
            {groupTitle(td, item.groupId)}
          </Link>
        )}
        <time class="card-time" dateTime={new Date(item.createdAt).toISOString()}>
          {formatAbsolute(item.createdAt)} · {formatRelative(item.createdAt)}
        </time>
      </header>

      {moved && (
        <p class="moved-note">
          Moved to {[movedState && item.state, movedGroup && `group “${groupTitle(td, item.groupId)}”`].filter(Boolean).join(' / ')}. It stays here until you refresh the list.
        </p>
      )}

      {td.config?.title && (
        <h3 class="card-title">
          {item.title ? (
            item.title
          ) : (
            <Badge kind="warn" title="Legacy submission without a name: edit it to add one">
              Untitled
            </Badge>
          )}
        </h3>
      )}

      <div class="card-payload">
        <PayloadView kind="summary" payload={item.payload} groupId={item.groupId} />
        {td.plugin.status === 'ready' && (
          <>
            <button type="button" class="btn-link" aria-expanded={detail} onClick={() => setDetail((v) => !v)}>
              {detail ? 'Hide full detail' : 'Show full detail'}
            </button>
            {detail && <PayloadView kind="detail" payload={item.payload} groupId={item.groupId} />}
          </>
        )}
      </div>

      <div class="chips">
        {tags.map((t) => (
          <span class="chip" key={t.key}>
            {t.label}: {t.value}
          </span>
        ))}
        <span class="chip">{langLabel(td.config, item.lang)}</span>
        {demoOk && (
          <a class="chip chip-link" href={item.demoUrl} target="_blank" rel="noopener noreferrer nofollow">
            Demo ↗
          </a>
        )}
      </div>

      <div class="card-explanation">
        <button type="button" class="btn-link" aria-expanded={showExplanation} onClick={() => setShowExplanation((v) => !v)}>
          {showExplanation ? 'Hide explanation' : 'Show explanation'}
        </button>
        {showExplanation && <Explanation html={item.explanationHtml} />}
      </div>

      <p class="meta-line">
        <span>
          IP: <code>{item.ip ?? `${item.ipKey} (IP purged)`}</code>
        </span>
        {item.ip && item.ip !== item.ipKey && (
          <span>
            Key: <code>{item.ipKey}</code>
          </span>
        )}
        <span>
          Country:{' '}
          {item.country ? (
            <>
              <span aria-hidden="true">{flagEmoji(item.country)}</span> {item.country}
            </>
          ) : (
            'unknown'
          )}
        </span>
        <span>ID: {item.id.slice(0, 8)}</span>
        {edited && item.updatedAt !== item.createdAt && <span>Edited {formatRelative(item.updatedAt)}</span>}
      </p>

      {conflict && (
        <div class="notice notice-warn" role="alert">
          <span>Someone else changed this submission. Reload it to see the latest version.</span>
          <button type="button" class="btn btn-small" onClick={reload} disabled={busy}>
            Reload
          </button>
        </div>
      )}

      <div class="card-actions">
        {actions
          .filter((a) => a.state !== item.state)
          .map((a) => (
            <button key={a.state} type="button" class={`btn ${a.cls}`} disabled={busy} onClick={() => changeState(a.state)}>
              {a.label}
            </button>
          ))}
        <button type="button" class="btn" disabled={busy} onClick={openEdit}>
          Edit
        </button>
        <button type="button" class="btn" disabled={busy} onClick={() => setBlockOpen(true)}>
          Block IP
        </button>
        {edited && (
          <button type="button" class="btn-link" aria-expanded={showOriginal} onClick={() => setShowOriginal((v) => !v)}>
            {showOriginal ? 'Hide original' : 'Show original'}
          </button>
        )}
      </div>

      {showOriginal && item.original && <OriginalPanel original={item.original} />}

      {editOpen && Edit && (
        <Edit
          item={item}
          onClose={() => setEditOpen(false)}
          onSaved={(r) => {
            setEditOpen(false)
            onUpdate(r.item)
            if (r.purgeWarning) toast(r.purgeWarning, 'warn')
            td.reloadGroups()
          }}
          onConflictReload={async () => {
            await reload()
            setEditOpen(false)
          }}
        />
      )}
      {blockOpen && (
        <BlockIpDialog
          item={item}
          onClose={() => setBlockOpen(false)}
          onDone={() => {
            setBlockOpen(false)
            td.reloadGroups()
            onBlocked?.()
          }}
        />
      )}
    </article>
  )
}
