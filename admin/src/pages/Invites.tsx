import { useState } from 'preact/hooks'
import type { InviteDto, MeResponse } from '../../../src/shared/api-types.ts'
import { api, errorMessage } from '../api.ts'
import { Badge, Breadcrumbs, Empty, ErrorBox, Notice, Skeleton } from '../components/ui.tsx'
import { formatAbsolute, formatRelative } from '../format.ts'
import { useAsync, useTitle } from '../hooks.ts'
import { toast } from '../toast.tsx'

const STATUS_KIND = { active: 'ok', used: 'neutral', expired: 'warn', revoked: 'danger' } as const

export default function InvitesPage({ me }: { me: MeResponse }) {
  useTitle('Invites')
  const list = useAsync(() => api.get<{ invites: InviteDto[] }>('/invites'), [])
  const [selected, setSelected] = useState<string[]>(() => me.types.map((t) => t.id))
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<{ url: string; expiresAt: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function create(e: Event) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setCopied(false)
    try {
      setCreated(await api.post<{ url: string; expiresAt: number }>('/invites', { types: selected }))
      list.reload()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      toast('Could not copy automatically; select the link and copy it manually.', 'warn')
    }
  }

  async function revoke(inv: InviteDto) {
    if (!confirm('Revoke this invite link?')) return
    try {
      await api.del(`/invites/${inv.id}`)
      toast('Invite revoked.')
      list.reload()
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  return (
    <>
      <Breadcrumbs items={[{ label: 'Team' }, { label: 'Invites' }]} />
      <h1>Invites</h1>
      <p class="hint">An invite link is single-use and valid for a limited time. Whoever opens it while signed in with Discord becomes a moderator of the selected types.</p>

      <form class="panel form" onSubmit={create}>
        <fieldset class="fieldset">
          <legend class="field-label">Grant access to</legend>
          <div class="radio-row">
            {me.types.map((t) => (
              <label class="check" key={t.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(t.id)}
                  onChange={(e) => setSelected((s) => (e.currentTarget.checked ? [...s, t.id] : s.filter((x) => x !== t.id)))}
                />
                <span>{t.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {error && <Notice kind="error">{error}</Notice>}
        <div>
          <button type="submit" class="btn btn-primary" disabled={busy || selected.length === 0}>
            {busy ? 'Creating…' : 'Create invite link'}
          </button>
        </div>
        {created && (
          <div class="notice notice-info invite-link" role="status">
            <div class="invite-link-body">
              <strong>Copy this link now; it is shown only once.</strong>
              <input class="input input-mono" readOnly value={created.url} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} />
              <span class="hint">Expires {formatAbsolute(created.expiresAt)} ({formatRelative(created.expiresAt)}).</span>
            </div>
            <button type="button" class="btn" onClick={() => copy(created.url)}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
        )}
      </form>

      <h2>Your invites</h2>
      {list.error ? (
        <ErrorBox message={errorMessage(list.error)} onRetry={list.reload} />
      ) : !list.data ? (
        <Skeleton lines={4} />
      ) : list.data.invites.length === 0 ? (
        <Empty>You have not created any invites.</Empty>
      ) : (
        <ul class="rows">
          {list.data.invites.map((inv) => (
            <li class="row" key={inv.id}>
              <div class="row-main">
                <Badge kind={STATUS_KIND[inv.status]}>{inv.status}</Badge> <span>{inv.types.join(', ')}</span>
                <div class="hint">
                  Created {formatRelative(inv.createdAt)} · {inv.status === 'used' && inv.usedAt ? `used by ${inv.usedBy ?? 'someone'} ${formatRelative(inv.usedAt)}` : `expires ${formatAbsolute(inv.expiresAt)}`}
                </div>
              </div>
              {inv.status === 'active' && (
                <button type="button" class="btn btn-small btn-danger" onClick={() => revoke(inv)}>
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
