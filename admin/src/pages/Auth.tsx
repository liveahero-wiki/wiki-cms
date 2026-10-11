import { useState } from 'preact/hooks'
import { ApiError, api, errorMessage } from '../api.ts'
import { useTitle } from '../hooks.ts'
import { Link, navigate, safeNext, useLocation } from '../router.tsx'
import { refreshSession, signInWithDiscord, useSession } from '../session.ts'
import { Notice } from '../components/ui.tsx'

function DiscordButton({ callbackPath }: { callbackPath: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <button
        type="button"
        class="btn btn-primary btn-large"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError(null)
          try {
            await signInWithDiscord(callbackPath)
          } catch (e) {
            setError(errorMessage(e))
            setBusy(false)
          }
        }}
      >
        {busy ? 'Redirecting…' : 'Sign in with Discord'}
      </button>
      {error && <Notice kind="error">{error}</Notice>}
    </>
  )
}

export function LoginPage() {
  useTitle('Sign in')
  const { search } = useLocation()
  const next = safeNext(new URLSearchParams(search).get('next'))
  return (
    <section class="panel center-panel">
      <h1>Moderation portal</h1>
      <p>Sign in with Discord to moderate community submissions. Only your Discord username and avatar are requested; no email.</p>
      <DiscordButton callbackPath={next} />
    </section>
  )
}

export function InvitePage({ token }: { token: string }) {
  useTitle('Invite')
  const session = useSession()
  const [state, setState] = useState<{ status: 'idle' } | { status: 'busy' } | { status: 'done'; granted: string[] } | { status: 'error'; message: string; invalid: boolean }>({ status: 'idle' })

  async function claim() {
    setState({ status: 'busy' })
    try {
      const r = await api.post<{ granted: string[] }>('/invites/claim', { token })
      await refreshSession()
      setState({ status: 'done', granted: r.granted })
    } catch (e) {
      setState({ status: 'error', message: errorMessage(e), invalid: e instanceof ApiError && e.code === 'invalid_invite' })
    }
  }

  return (
    <section class="panel center-panel">
      <h1>Moderator invite</h1>
      {state.status === 'done' ? (
        <>
          {state.granted.length ? (
            <Notice>Invite accepted. You can now moderate: {state.granted.join(', ')}.</Notice>
          ) : (
            <Notice kind="warn">The invite was accepted, but it granted no permissions (the person who created it may have lost access). Ask for a new link.</Notice>
          )}
          <p>
            <button type="button" class="btn btn-primary" onClick={() => navigate('/')}>
              Open the portal
            </button>
          </p>
        </>
      ) : state.status === 'error' ? (
        <>
          <Notice kind="error">{state.invalid ? 'This invite link is invalid, expired or has already been used. Ask for a new link.' : state.message}</Notice>
          {!state.invalid && (
            <p>
              <button type="button" class="btn" onClick={claim}>
                Try again
              </button>
            </p>
          )}
          <p>
            <Link href="/">Go to the portal</Link>
          </p>
        </>
      ) : session.status === 'in' ? (
        <>
          <p>
            You are signed in as <strong>{session.me.user.name}</strong>. Accept this invite to become a moderator.
          </p>
          <button type="button" class="btn btn-primary btn-large" disabled={state.status === 'busy'} onClick={claim}>
            {state.status === 'busy' ? 'Accepting…' : 'Accept invite'}
          </button>
        </>
      ) : (
        <>
          <p>You have been invited to moderate community submissions. Sign in with Discord first; you will come back here to accept the invite. Only your Discord username and avatar are requested.</p>
          <DiscordButton callbackPath={`/invite/${token}`} />
        </>
      )}
    </section>
  )
}
