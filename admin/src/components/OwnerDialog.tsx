import { useEffect, useState } from 'preact/hooks'
import type { AdminOwner, AdminSubmission, ContributorsResponse, ModerationResponse, SetOwnerRequest } from '../../../src/shared/api-types.ts'
import { api, errorMessage } from '../api.ts'
import { ownerAccountLabel, ownerAccountUrl } from '../revisions.ts'
import { Dialog, Notice } from './ui.tsx'

/** "Name" plus the provider account in a secondary style, or "Anonymous (legacy)". */
export function OwnerLabel({ owner }: { owner: AdminOwner | null | undefined }) {
  if (!owner) return <span class="owner owner-none">Anonymous (legacy)</span>
  const account = ownerAccountLabel(owner)
  const url = ownerAccountUrl(owner)
  return (
    <span class="owner">
      <span class="owner-name">{owner.displayName}</span>
      {account && (
        <small class="owner-account" title={`${owner.provider ?? 'account'}: ${owner.accountId}`}>
          {url ? (
            <a href={url} target="_blank" rel="noopener noreferrer">
              {account}
            </a>
          ) : (
            account
          )}
        </small>
      )}
    </span>
  )
}

type Contributor = ContributorsResponse['contributors'][number]

interface Props {
  item: AdminSubmission
  onClose: () => void
  onSaved: (r: ModerationResponse) => void
}

/** Search contributors, pick one and assign them as the submission's owner (or clear the owner). */
export function OwnerDialog({ item, onClose, onSaved }: Props) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Contributor[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [picked, setPicked] = useState<Contributor | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const query = q.trim()

  useEffect(() => {
    setSearchError(null)
    if (query.length < 2) {
      setResults(null)
      setSearching(false)
      return
    }
    let live = true
    setSearching(true)
    const t = setTimeout(() => {
      api.get<ContributorsResponse>(`/contributors?q=${encodeURIComponent(query)}`).then(
        (r) => {
          if (!live) return
          setResults(r.contributors)
          setSearching(false)
        },
        (e) => {
          if (!live) return
          setResults(null)
          setSearchError(errorMessage(e))
          setSearching(false)
        },
      )
    }, 300)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [query])

  async function save(userId: string | null) {
    setBusy(true)
    setError(null)
    try {
      const body: SetOwnerRequest = { userId }
      onSaved(await api.post<ModerationResponse>(`/submissions/${encodeURIComponent(item.id)}/owner`, body))
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  const owner = item.owner ?? null
  return (
    <Dialog title={owner ? 'Change owner' : 'Assign owner'} onClose={onClose} canClose={() => !busy} dismissOnBackdrop labelId="owner-title">
      <form
        class="form"
        onSubmit={(e) => {
          e.preventDefault()
          if (picked) void save(picked.id)
        }}
      >
        <p class="hint">
          Current owner: <OwnerLabel owner={owner} />. The owner can edit this submission from their contributor account (edits are reviewed before they replace the published version).
        </p>
        <label class="field">
          <span class="field-label">Find a contributor</span>
          <input
            class="input"
            type="search"
            placeholder="Display name, Bluesky handle, account id or user id"
            value={q}
            onInput={(e) => {
              setQ(e.currentTarget.value)
              setPicked(null)
            }}
            disabled={busy}
            autoFocus
          />
        </label>
        {query.length > 0 && query.length < 2 && <p class="hint">Type at least 2 characters.</p>}
        {searching && <p class="hint" role="status">Searching…</p>}
        {searchError && <Notice kind="error">{searchError}</Notice>}
        {results && !searching && results.length === 0 && <p class="hint">No contributor matches. They need to have signed in on the public site at least once.</p>}
        {results && results.length > 0 && (
          <ul class="pick-list" aria-label="Contributors">
            {results.map((c) => (
              <li key={c.id}>
                <button type="button" class="pick-item" aria-pressed={picked?.id === c.id} onClick={() => setPicked(c)} disabled={busy}>
                  <OwnerLabel owner={c} />
                  <small class="owner-account">ID {c.id.slice(0, 8)}</small>
                </button>
              </li>
            ))}
          </ul>
        )}
        {picked && (
          <p role="status">
            {owner ? 'Change' : 'Assign'} the owner of this submission to <strong>{picked.displayName}</strong>?
          </p>
        )}
        {error && <Notice kind="error">{error}</Notice>}
        <div class="dialog-actions">
          {owner && (
            <button type="button" class="btn btn-danger" onClick={() => save(null)} disabled={busy}>
              Clear owner
            </button>
          )}
          <button type="button" class="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" class="btn btn-ok" disabled={busy || !picked || picked.id === owner?.id}>
            {owner ? 'Change owner' : 'Assign owner'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
