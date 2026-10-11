import { useEffect, useRef, useState } from 'preact/hooks'
import type { AdminSubmission, SubmissionState, SubmissionsResponse } from '../../../src/shared/api-types.ts'
import { api, errorMessage } from '../api.ts'
import { useTypeData } from '../typeData.tsx'
import { SubmissionCard } from './SubmissionCard.tsx'
import { Empty, ErrorBox, Notice, Skeleton } from './ui.tsx'

interface Props {
  typeId: string
  /** Omit for the cross-group queue of the type. */
  groupId?: string
  state: SubmissionState
}

/** Keyset-paginated list of submission cards ("Load more"). */
export function SubmissionList({ typeId, groupId, state }: Props) {
  const td = useTypeData()
  const [items, setItems] = useState<AdminSubmission[]>([])
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
      const qs = new URLSearchParams({ state, limit: '50' })
      if (groupId) qs.set('group', groupId)
      if (from) qs.set('cursor', from)
      const r = await api.get<SubmissionsResponse>(`/types/${encodeURIComponent(typeId)}/submissions?${qs}`)
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

  /** Reload the list and the group counts (tab badges). */
  function refresh() {
    td.reloadGroups()
    void load(true)
  }

  useEffect(() => {
    void load(true)
    return () => {
      req.current++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeId, groupId, state])

  const ready = (td.groups !== undefined || td.groupsError) && (td.config !== undefined || td.configError) && td.plugin.status !== 'loading'

  return (
    <div class="list">
      {td.plugin.status === 'failed' && (
        <Notice kind="warn">The plugin for this type could not be loaded ({td.plugin.error}). Raw JSON payloads are shown instead; moderation still works.</Notice>
      )}
      {td.groupsError && <Notice kind="warn">Group details could not be loaded ({td.groupsError}); plugin views may lack group options.</Notice>}
      {error && <ErrorBox message={error} onRetry={() => load(items.length === 0, items.length === 0 ? null : cursor)} />}
      {ready && (
        <div class="list-bar">
          <span class="hint">
            {items.length > 0 && `Showing ${items.length} submission${items.length === 1 ? '' : 's'}, newest first`}
          </span>
          <button type="button" class="btn btn-small" onClick={refresh} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      )}
      {!ready || (loading && items.length === 0) ? (
        <Skeleton lines={6} height="1.2em" />
      ) : items.length === 0 && !error ? (
        <Empty>No {state} submissions{groupId ? ' in this group' : ''}.</Empty>
      ) : (
        <>
          {items.map((it) => (
            <SubmissionCard
              key={it.id}
              item={it}
              listState={state}
              listGroup={groupId}
              showGroup={!groupId}
              onUpdate={(next) => setItems((prev) => prev.map((p) => (p.id === next.id ? next : p)))}
              onBlocked={() => load(true)}
            />
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
