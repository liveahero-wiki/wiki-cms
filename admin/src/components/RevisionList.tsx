import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { AdminRevision, ApproveRevisionRequest, ModerationResponse, RejectRevisionRequest, RevisionsResponse } from '../../../src/shared/api-types.ts'
import { ApiError, api, errorMessage } from '../api.ts'
import { formatAbsolute, formatRelative } from '../format.ts'
import { baseIsStale, changedFields, type RevisionField } from '../revisions.ts'
import { toast } from '../toast.tsx'
import { groupTitle, langLabel, tagLabels, useTypeData } from '../typeData.tsx'
import { OwnerLabel } from './OwnerDialog.tsx'
import { Explanation, PayloadView } from './SubmissionCard.tsx'
import { Badge, Empty, ErrorBox, Notice, Skeleton } from './ui.tsx'

export type RevisionState = AdminRevision['state']

const REJECT_REASON_MAX = 500
const FIELD_LABEL: Record<RevisionField, string> = {
  title: 'Name',
  payload: 'Content',
  tags: 'Tags',
  lang: 'Language',
  demoUrl: 'Demo URL',
  explanation: 'Explanation',
}
const STATE_BADGE = { pending: 'warn', approved: 'ok', rejected: 'danger', withdrawn: 'neutral' } as const

interface Side {
  title: string
  payload: unknown
  tags: Record<string, string>
  lang: AdminRevision['lang']
  demoUrl: string
  explanationHtml: string
}

function DemoLink({ url }: { url: string }) {
  return /^https?:\/\//i.test(url) ? (
    <a href={url} target="_blank" rel="noopener noreferrer nofollow">
      {url}
    </a>
  ) : (
    <span>{url}</span>
  )
}

function FieldRow({ field, changed, hide, children }: { field: RevisionField; changed: boolean; hide?: boolean; children: (side: 'current' | 'proposed') => ComponentChildren }) {
  if (hide) return null
  return (
    <div class={`rev-row${changed ? ' rev-changed' : ''}`}>
      <div class="rev-label">
        {FIELD_LABEL[field]}
        {changed && <Badge kind="accent">changed</Badge>}
      </div>
      <div class="rev-cell" data-side="current">
        {children('current')}
      </div>
      <div class="rev-cell" data-side="proposed">
        {children('proposed')}
      </div>
    </div>
  )
}

interface CardProps {
  rev: AdminRevision
  /** The revision was decided (or became stale) elsewhere: reload the list. */
  onReload: () => void
  onDone: (id: string) => void
}

function RevisionCard({ rev, onReload, onDone }: CardProps) {
  const td = useTypeData()
  const sub = rev.submission
  const [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const pending = rev.state === 'pending'
  // Only a pending edit is compared with what it would replace. A decided one is shown next to the submission as it is
  // NOW (its base version is not stored), so a field-by-field "changed" would be misleading there.
  const changed = pending ? changedFields(sub, { ...rev }) : []
  const stale = baseIsStale(rev)
  const sides: { current: Side; proposed: Side } = {
    current: { ...sub },
    proposed: { ...rev },
  }
  const has = (f: RevisionField) => changed.includes(f)

  async function decide(kind: 'approve' | 'reject') {
    setBusy(true)
    setMessage(null)
    try {
      if (kind === 'approve') {
        const body: ApproveRevisionRequest = { expectedVersion: sub.version }
        const r = await api.post<ModerationResponse>(`/revisions/${encodeURIComponent(rev.id)}/approve`, body)
        if (r.purgeWarning) toast(r.purgeWarning, 'warn')
        toast('Edit approved and published.')
      } else {
        const body: RejectRevisionRequest = reason.trim() ? { reason: reason.trim() } : {}
        await api.post<{ ok: true }>(`/revisions/${encodeURIComponent(rev.id)}/reject`, body)
        toast('Edit rejected.')
      }
      td.reloadGroups()
      onDone(rev.id)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Changed under us (version_conflict) or already decided/withdrawn (not_pending): show the latest state.
        toast(`${e.message} The list was reloaded.`, 'warn')
        setBusy(false)
        onReload()
      } else {
        setMessage(errorMessage(e))
        setBusy(false)
      }
    }
  }

  const tagsOf = (s: Side) => tagLabels(td.config, s.tags)

  return (
    <article class="card rev-card" aria-label={`Edit of submission ${sub.id.slice(0, 8)}`} data-state={rev.state}>
      <header class="card-head">
        <Badge kind={STATE_BADGE[rev.state]}>{rev.state}</Badge>
        <span class="card-group">{groupTitle(td, sub.groupId)}</span>
        <span class="hint">
          proposed by <OwnerLabel owner={rev.owner} />
        </span>
        <time class="card-time" dateTime={new Date(rev.createdAt).toISOString()}>
          {formatAbsolute(rev.createdAt)} · {formatRelative(rev.createdAt)}
        </time>
      </header>

      {pending && stale && (
        <Notice kind="warn">
          A moderator changed this submission after the contributor started editing (they saw version {rev.baseVersion}, now version {sub.version}). Approving overwrites that change.
        </Notice>
      )}
      {pending && sub.state !== 'approved' && (
        <Notice kind="info">This submission is currently {sub.state}, so approving the edit does not publish it.</Notice>
      )}
      {!pending ? (
        <p class="hint">The left column shows the submission as it is now, not as it was when this edit was proposed.</p>
      ) : changed.length === 0 ? (
        <p class="hint">No visible differences from the published version.</p>
      ) : (
        <p class="hint">Changed: {changed.map((f) => FIELD_LABEL[f]).join(', ')}</p>
      )}

      <div class="rev-compare">
        <div class="rev-row rev-head">
          <div class="rev-label" />
          <div class="rev-cell">
            <strong>{pending ? 'Published' : 'Now'}</strong> <span class="hint">(version {sub.version})</span>
          </div>
          <div class="rev-cell">
            <strong>Proposed</strong> <span class="hint">(based on version {rev.baseVersion})</span>
          </div>
        </div>

        <FieldRow field="title" changed={has('title')} hide={!td.config?.title}>
          {(side) => (sides[side].title ? <span class="card-title">{sides[side].title}</span> : <span class="hint">Untitled</span>)}
        </FieldRow>

        <FieldRow field="payload" changed={has('payload')}>
          {(side) => (
            <>
              <PayloadView kind="summary" payload={sides[side].payload} groupId={sub.groupId} />
              {detail && td.plugin.status === 'ready' && <PayloadView kind="detail" payload={sides[side].payload} groupId={sub.groupId} />}
            </>
          )}
        </FieldRow>
        {td.plugin.status === 'ready' && (
          <button type="button" class="btn-link" aria-expanded={detail} onClick={() => setDetail((v) => !v)}>
            {detail ? 'Hide full detail' : 'Show full detail'}
          </button>
        )}

        <FieldRow field="tags" changed={has('tags')}>
          {(side) => (
            <div class="chips">
              {tagsOf(sides[side]).map((t) => (
                <span class="chip" key={t.key}>
                  {t.label}: {t.value}
                </span>
              ))}
              {tagsOf(sides[side]).length === 0 && <span class="hint">None</span>}
            </div>
          )}
        </FieldRow>

        <FieldRow field="lang" changed={has('lang')}>
          {(side) => <span>{langLabel(td.config, sides[side].lang)}</span>}
        </FieldRow>

        <FieldRow field="demoUrl" changed={has('demoUrl')}>
          {(side) => <DemoLink url={sides[side].demoUrl} />}
        </FieldRow>

        <FieldRow field="explanation" changed={has('explanation')}>
          {(side) => <Explanation html={sides[side].explanationHtml} />}
        </FieldRow>
      </div>

      {rev.state === 'rejected' && rev.rejectReason && <p class="hint">Reason: {rev.rejectReason}</p>}
      {rev.decidedAt !== null && (
        <p class="meta-line">
          <span>
            Decided {formatRelative(rev.decidedAt)}
            {rev.decidedBy ? ` by ${rev.decidedBy}` : ''}
          </span>
        </p>
      )}
      <p class="meta-line">
        <span>Edit ID: {rev.id.slice(0, 8)}</span>
        <span>Submission: {sub.id.slice(0, 8)}</span>
      </p>

      {message && <Notice kind="error">{message}</Notice>}

      {pending && !rejecting && (
        <div class="card-actions">
          <button type="button" class="btn btn-ok" disabled={busy} onClick={() => decide('approve')}>
            {busy ? 'Working…' : stale ? 'Approve and overwrite' : 'Approve'}
          </button>
          <button type="button" class="btn btn-danger" disabled={busy} onClick={() => setRejecting(true)}>
            Reject…
          </button>
        </div>
      )}
      {pending && rejecting && (
        <form
          class="form rev-reject"
          onSubmit={(e) => {
            e.preventDefault()
            void decide('reject')
          }}
        >
          <label class="field">
            <span class="field-label">Reason for the contributor (optional, {REJECT_REASON_MAX} characters max)</span>
            <textarea class="input" rows={3} maxLength={REJECT_REASON_MAX} value={reason} onInput={(e) => setReason(e.currentTarget.value)} disabled={busy} autoFocus />
          </label>
          <div class="card-actions">
            <button type="submit" class="btn btn-danger" disabled={busy}>
              {busy ? 'Rejecting…' : 'Confirm reject'}
            </button>
            <button type="button" class="btn" disabled={busy} onClick={() => setRejecting(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </article>
  )
}

interface Props {
  typeId: string
  state: RevisionState
}

/** Keyset-paginated list of contributor edits ("Load more"). Decided items leave the pending list. */
export function RevisionList({ typeId, state }: Props) {
  const td = useTypeData()
  const [items, setItems] = useState<AdminRevision[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const req = useRef(0)

  async function load(reset: boolean, from: string | null = null) {
    const id = ++req.current
    if (reset) {
      setLoading(true)
      setItems([])
    } else setMore(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ state, limit: '25' })
      if (from) qs.set('cursor', from)
      const r = await api.get<RevisionsResponse>(`/types/${encodeURIComponent(typeId)}/revisions?${qs}`)
      if (id !== req.current) return
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.id))
        return [...prev, ...r.items.filter((i) => !seen.has(i.id))]
      })
      setCursor(r.nextCursor)
    } catch (e) {
      if (id === req.current) setError(errorMessage(e))
    } finally {
      if (id === req.current) {
        setLoading(false)
        setMore(false)
      }
    }
  }

  useEffect(() => {
    void load(true)
    return () => {
      req.current++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeId, state])

  const ready = (td.groups !== undefined || td.groupsError) && (td.config !== undefined || td.configError) && td.plugin.status !== 'loading'

  return (
    <div class="list">
      {td.plugin.status === 'failed' && (
        <Notice kind="warn">The plugin for this type could not be loaded ({td.plugin.error}). Raw JSON payloads are shown instead; moderation still works.</Notice>
      )}
      {error && <ErrorBox message={error} onRetry={() => load(items.length === 0, items.length === 0 ? null : cursor)} />}
      {ready && (
        <div class="list-bar">
          <span class="hint">{items.length > 0 && `${items.length} ${state} edit${items.length === 1 ? '' : 's'} loaded, newest first`}</span>
          <button type="button" class="btn btn-small" onClick={() => load(true)} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      )}
      {!ready || (loading && items.length === 0) ? (
        <Skeleton lines={6} height="1.2em" />
      ) : items.length === 0 && !error ? (
        <Empty>No {state} contributor edits.</Empty>
      ) : (
        <>
          {items.map((rev) => (
            <RevisionCard key={rev.id} rev={rev} onReload={() => load(true)} onDone={(id) => setItems((prev) => prev.filter((p) => p.id !== id))} />
          ))}
          {cursor && (
            <div class="load-more">
              <button type="button" class="btn" onClick={() => load(false, cursor)} disabled={more}>
                {more ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
