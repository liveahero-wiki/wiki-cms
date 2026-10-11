import { useState } from 'preact/hooks'
import type { AdminSubmission, SubmissionsResponse } from '../../../src/shared/api-types.ts'
import { api, errorMessage } from '../api.ts'
import { toast } from '../toast.tsx'
import { Dialog, Notice } from './ui.tsx'

interface Props {
  item: AdminSubmission
  onClose: () => void
  onDone: () => void
}

/** Collects every pending submission id of `type` from this IP key (keyset pages of 100). */
async function pendingIdsFromIp(type: string, ipKey: string): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | null = null
  do {
    const qs: string = `state=pending&limit=100&ipKey=${encodeURIComponent(ipKey)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const page: SubmissionsResponse = await api.get<SubmissionsResponse>(`/types/${encodeURIComponent(type)}/submissions?${qs}`)
    ids.push(...page.items.map((i) => i.id))
    cursor = page.nextCursor
  } while (cursor)
  return ids
}

export function BlockIpDialog({ item, onClose, onDone }: Props) {
  const [ipKey, setIpKey] = useState(item.ipKey)
  const [reason, setReason] = useState('')
  const [alsoSpam, setAlsoSpam] = useState(true)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: Event) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      setProgress('Blocking…')
      const blocked = await api.post<{ ipKey: string }>('/ip-blocks', { ip: ipKey.trim(), reason: reason.trim() || undefined })
      let marked = 0
      let warning: string | null = null
      if (alsoSpam) {
        setProgress('Finding pending submissions…')
        const ids = await pendingIdsFromIp(item.type, blocked.ipKey)
        for (let i = 0; i < ids.length; i += 50) {
          setProgress(`Marking spam… ${Math.min(i + 50, ids.length)} of ${ids.length}`)
          const r = await api.post<{ changed: number; purgeWarning: string | null }>('/submissions/bulk-state', { ids: ids.slice(i, i + 50), state: 'spam' })
          marked += r.changed
          warning = r.purgeWarning ?? warning
        }
      }
      toast(`Blocked ${blocked.ipKey}${alsoSpam ? `; marked ${marked} pending submission${marked === 1 ? '' : 's'} as spam` : ''}.`)
      if (warning) toast(warning, 'warn')
      onDone()
    } catch (err) {
      setError(errorMessage(err))
      setProgress(null)
      setBusy(false)
    }
  }

  return (
    <Dialog title="Block IP" onClose={onClose} canClose={() => !busy} dismissOnBackdrop labelId="block-title">
      <form class="form" onSubmit={submit}>
        <p class="hint">Blocked networks can no longer submit to any type. IPv6 addresses are blocked by their /64 prefix.</p>
        <label class="field">
          <span class="field-label">IP key</span>
          <input class="input" value={ipKey} onInput={(e) => setIpKey(e.currentTarget.value)} required disabled={busy} autoFocus />
        </label>
        <label class="field">
          <span class="field-label">Reason (optional)</span>
          <input class="input" value={reason} maxLength={500} onInput={(e) => setReason(e.currentTarget.value)} disabled={busy} />
        </label>
        <label class="check">
          <input type="checkbox" checked={alsoSpam} onChange={(e) => setAlsoSpam(e.currentTarget.checked)} disabled={busy} />
          <span>Also mark this IP&apos;s pending submissions in this type as spam</span>
        </label>
        {error && <Notice kind="error">{error}</Notice>}
        {progress && <p class="hint" role="status">{progress}</p>}
        <div class="dialog-actions">
          <button type="button" class="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" class="btn btn-danger" disabled={busy || !ipKey.trim()}>
            Block IP
          </button>
        </div>
      </form>
    </Dialog>
  )
}
