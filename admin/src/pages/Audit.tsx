import { useEffect, useRef, useState } from 'preact/hooks'
import type { AuditEntryDto, MeResponse } from '../../../src/shared/api-types.ts'
import { api, errorMessage } from '../api.ts'
import { Breadcrumbs, Empty, ErrorBox, Skeleton } from '../components/ui.tsx'
import { formatAbsolute, formatRelative } from '../format.ts'
import { useTitle } from '../hooks.ts'

interface AuditResponse {
  entries: AuditEntryDto[]
  nextCursor: number | null
}

export default function AuditPage({ me }: { me: MeResponse }) {
  useTitle('Audit log')
  const [type, setType] = useState('')
  const [entries, setEntries] = useState<AuditEntryDto[]>([])
  const [cursor, setCursor] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const req = useRef(0)

  async function load(reset: boolean, from: number | null = null) {
    const id = ++req.current
    if (reset) {
      setLoading(true)
      setEntries([])
    } else setMore(true)
    setError(null)
    try {
      const qs = new URLSearchParams()
      if (type) qs.set('type', type)
      if (from) qs.set('cursor', String(from))
      const r = await api.get<AuditResponse>(`/audit?${qs}`)
      if (id !== req.current) return
      setEntries((prev) => [...prev, ...r.entries])
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
  }, [type])

  return (
    <>
      <Breadcrumbs items={[{ label: 'Team' }, { label: 'Audit log' }]} />
      <h1>Audit log</h1>
      <p class="hint">Moderator actions of the last 30 days, newest first.</p>
      <div class="toolbar">
        <label class="field field-inline">
          <span class="field-label">Type</span>
          <select class="input" value={type} onChange={(e) => setType(e.currentTarget.value)}>
            <option value="">All my types</option>
            {me.types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" class="btn btn-small" onClick={() => load(true)} disabled={loading}>
          Refresh
        </button>
      </div>
      {error && <ErrorBox message={error} onRetry={() => load(entries.length === 0, entries.length ? cursor : null)} />}
      {loading && entries.length === 0 ? (
        <Skeleton lines={6} />
      ) : entries.length === 0 && !error ? (
        <Empty>No audit entries.</Empty>
      ) : (
        <>
          <ul class="rows audit">
            {entries.map((en) => (
              <li class="row row-block" key={en.id}>
                <div class="audit-head">
                  <code class="audit-action">{en.action}</code>
                  <span>
                    by <strong>{en.actorName}</strong>
                  </span>
                  {en.type && <span class="chip">{en.type}</span>}
                  {en.target && (
                    <span class="hint">
                      target <code>{en.target.length > 24 ? `${en.target.slice(0, 8)}…` : en.target}</code>
                    </span>
                  )}
                  <time class="card-time">
                    {formatAbsolute(en.at)} · {formatRelative(en.at)}
                  </time>
                </div>
                {en.detail !== null && en.detail !== undefined && (
                  <details class="audit-detail">
                    <summary>Details</summary>
                    <pre class="raw-json">{JSON.stringify(en.detail, null, 2)}</pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
          {cursor && (
            <div class="load-more">
              <button type="button" class="btn" onClick={() => load(false, cursor)} disabled={more}>
                {more ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </>
  )
}
