import { useState } from 'preact/hooks'
import type { Lang } from '../../src/shared/i18n.ts'
import { CONTRIB_MIN_ACCOUNT_AGE_DAYS } from '../../src/shared/contrib.ts'
import { rename, signOut } from './contrib-api.ts'
import { SignInError, signIn, type StoredSession } from './contrib-session.ts'
import { apiErrorText, t } from './i18n/t.ts'
import { ApiError } from './shared.ts'

const PROVIDER = { id: 'discord', label: 'Discord' }

/** Localized text for a failed sign-in popup. */
export function signInErrorText(lang: Lang, e: unknown): string {
  if (!(e instanceof SignInError)) return t(lang, 'account.failed')
  switch (e.code) {
    case 'popup_blocked':
      return t(lang, 'account.popupBlocked')
    case 'closed':
      return t(lang, 'account.closed')
    case 'account_too_young': {
      const params = { provider: PROVIDER.label, days: CONTRIB_MIN_ACCOUNT_AGE_DAYS }
      if (!e.eligibleAt) return t(lang, 'account.tooYoungNoDate', params)
      return t(lang, 'account.tooYoung', { ...params, date: new Date(e.eligibleAt).toLocaleDateString(lang) })
    }
    default:
      return t(lang, 'account.failed')
  }
}

/** Shown instead of the form when the type needs an account and nobody is signed in. */
export function SignInGate({ api, lang, onCancel }: { api: string; lang: Lang; onCancel(): void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const start = () => {
    if (busy) return
    setBusy(true)
    setError(null)
    // `signIn` opens the popup synchronously, inside this click handler.
    signIn(api, PROVIDER.id).then(
      () => setBusy(false), // the Shell notices the stored session and swaps in the form
      (e) => {
        setBusy(false)
        setError(signInErrorText(lang, e))
      },
    )
  }
  return (
    <>
      <div class="cms-dlg-body">
        <p>{t(lang, 'account.signInPrompt')}</p>
        {error && (
          <p class="cms-error" role="alert">
            {error}
          </p>
        )}
        {busy && (
          <p class="cms-hint" role="status">
            {t(lang, 'account.waiting')}
          </p>
        )}
      </div>
      <div class="cms-dlg-foot">
        <div class="cms-actions">
          <button type="button" class="cms-btn" onClick={onCancel}>
            {t(lang, 'form.cancel')}
          </button>
          <button type="button" class="cms-btn cms-primary" disabled={busy} onClick={start}>
            {t(lang, 'account.signInWith', { provider: PROVIDER.label })}
          </button>
        </div>
      </div>
    </>
  )
}

/** "Signed in as X · Change name · Sign out" strip at the top of the form. */
export function AccountBar({ api, lang, session }: { api: string; lang: Lang; session: StoredSession }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(session.user.displayName)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async (e: Event) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await rename(api, name)
      setEditing(false)
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'validation_failed' ? t(lang, 'account.nameInvalid') : apiErrorText(lang, err instanceof ApiError ? err.code : 'unknown'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div class="cms-account">
      {editing ? (
        <div class="cms-account-edit">
          <label class="cms-label" for="cms-acct-name">
            {t(lang, 'account.nameLabel')}
          </label>
          <input
            id="cms-acct-name"
            class="cms-input"
            type="text"
            value={name}
            maxLength={64}
            autocomplete="off"
            aria-describedby="cms-acct-hint"
            onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === 'Enter' && save(e)}
          />
          <p class="cms-hint" id="cms-acct-hint">
            {t(lang, 'account.nameHint')}
          </p>
          {error && (
            <p class="cms-error" role="alert">
              {error}
            </p>
          )}
          <div class="cms-actions">
            <button type="button" class="cms-btn" onClick={() => (setEditing(false), setName(session.user.displayName), setError(null))}>
              {t(lang, 'form.cancel')}
            </button>
            <button type="button" class="cms-btn cms-primary" disabled={busy} onClick={save}>
              {t(lang, 'account.save')}
            </button>
          </div>
        </div>
      ) : (
        <p class="cms-hint">
          {t(lang, 'account.signedInAs', { name: session.user.displayName })} ·{' '}
          <button type="button" class="cms-link" onClick={() => (setName(session.user.displayName), setEditing(true))}>
            {t(lang, 'account.rename')}
          </button>{' '}
          ·{' '}
          <button type="button" class="cms-link" onClick={() => void signOut(api)}>
            {t(lang, 'account.signOut')}
          </button>
        </p>
      )}
    </div>
  )
}
