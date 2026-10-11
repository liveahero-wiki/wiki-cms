import { useState } from 'preact/hooks'
import { api, errorMessage } from '../api.ts'
import { Breadcrumbs, Empty, ErrorBox, Notice, Skeleton } from '../components/ui.tsx'
import { formatAbsolute, formatRelative } from '../format.ts'
import { useAsync, useTitle } from '../hooks.ts'
import { toast } from '../toast.tsx'

interface IpBlock {
  ipKey: string
  reason: string | null
  createdBy: string | null
  createdAt: number
}

export default function IpBlocksPage() {
  useTitle('IP blocks')
  const list = useAsync(() => api.get<{ blocks: IpBlock[] }>('/ip-blocks'), [])
  const [ip, setIp] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function add(e: Event) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api.post<{ ipKey: string }>('/ip-blocks', { ip: ip.trim(), reason: reason.trim() || undefined })
      toast(`Blocked ${r.ipKey}.`)
      setIp('')
      setReason('')
      list.reload()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function remove(b: IpBlock) {
    if (!confirm(`Unblock ${b.ipKey}?`)) return
    try {
      // The key (e.g. "2001:db8:1:2::") goes into the path as-is.
      await api.del(`/ip-blocks/${b.ipKey}`)
      toast(`Unblocked ${b.ipKey}.`)
      list.reload()
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  return (
    <>
      <Breadcrumbs items={[{ label: 'Team' }, { label: 'IP blocks' }]} />
      <h1>IP blocks</h1>
      <p class="hint">The block list is global (all types). IPv6 addresses are blocked by their /64 prefix.</p>
      <form class="panel form form-row" onSubmit={add}>
        <label class="field">
          <span class="field-label">IP address</span>
          <input class="input" value={ip} onInput={(e) => setIp(e.currentTarget.value)} placeholder="203.0.113.7 or 2001:db8::1" required disabled={busy} />
        </label>
        <label class="field">
          <span class="field-label">Reason (optional)</span>
          <input class="input" value={reason} maxLength={500} onInput={(e) => setReason(e.currentTarget.value)} disabled={busy} />
        </label>
        <div class="field-actions">
          <button type="submit" class="btn btn-danger" disabled={busy || !ip.trim()}>
            Block IP
          </button>
        </div>
        {error && <Notice kind="error">{error}</Notice>}
      </form>

      {list.error ? (
        <ErrorBox message={errorMessage(list.error)} onRetry={list.reload} />
      ) : !list.data ? (
        <Skeleton lines={4} />
      ) : list.data.blocks.length === 0 ? (
        <Empty>No blocked IPs.</Empty>
      ) : (
        <ul class="rows">
          {list.data.blocks.map((b) => (
            <li class="row" key={b.ipKey}>
              <div class="row-main">
                <code>{b.ipKey}</code>
                <div class="hint">
                  {b.reason ? `${b.reason} · ` : ''}blocked <time title={formatAbsolute(b.createdAt)}>{formatRelative(b.createdAt)}</time>
                  {b.createdBy ? ` by ${b.createdBy}` : ''}
                </div>
              </div>
              <button type="button" class="btn btn-small" onClick={() => remove(b)}>
                Unblock
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
