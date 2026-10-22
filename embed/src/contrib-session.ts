// Contributor sign-in for the embed. Dependency-free on purpose: the tiny loader (`v1.js`) imports it, so a wiki page can
// check "am I signed in?" and open the popup (which must happen synchronously inside a click) without loading Preact.
//
// The session is a bearer token the Worker's popup page posts to this window. It lives in `localStorage` of the WIKI origin
// (not the Worker's), under `cms-contrib:<api origin>`. It is only ever sent to `/api/contrib/*`, which accepts no cookies.
import type { ContribAuthMessage, ContribUser } from '../../src/shared/api-types.ts'

export interface StoredSession {
  token: string
  user: ContribUser
}

export type SignInErrorCode = 'popup_blocked' | 'closed' | 'account_too_young' | 'age_check_unavailable' | 'unauthenticated' | 'unavailable'

export class SignInError extends Error {
  constructor(
    public code: SignInErrorCode,
    public eligibleAt: number | null = null,
  ) {
    super(code)
  }
}

const storeKey = (api: string) => `cms-contrib:${api}`
const CHANGE_EVENT = 'cms:contrib'
const memory = new Map<string, StoredSession | null>()

const normalize = (api: string) => api.replace(/\/+$/, '')

export function readSession(api: string): StoredSession | null {
  try {
    const raw = localStorage.getItem(storeKey(normalize(api)))
    if (!raw) return null
    const s = JSON.parse(raw) as Partial<StoredSession>
    if (typeof s?.token !== 'string' || typeof s.user?.id !== 'string' || typeof s.user.displayName !== 'string') return null
    return { token: s.token, user: { id: s.user.id, displayName: s.user.displayName, image: s.user.image ?? null } }
  } catch {
    return null
  }
}

/** Stores (or clears, with null) the session and tells every listener on this page; other tabs hear the `storage` event. */
export function writeSession(api: string, s: StoredSession | null): void {
  const a = normalize(api)
  try {
    if (s) localStorage.setItem(storeKey(a), JSON.stringify(s))
    else localStorage.removeItem(storeKey(a))
    memory.delete(a)
  } catch {
    /* storage unavailable (private mode): keep the session in memory for this page only */
    memory.set(a, s)
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { api: a } }))
}

/** `readSession` that also works when localStorage is blocked (private mode): falls back to this page's memory. */
export function currentSession(api: string): StoredSession | null {
  return readSession(api) ?? memory.get(normalize(api)) ?? null
}

export function onSessionChange(api: string, cb: () => void): () => void {
  const a = normalize(api)
  const onCustom = (e: Event) => (e as CustomEvent<{ api: string }>).detail?.api === a && cb()
  const onStorage = (e: StorageEvent) => e.key === storeKey(a) && cb()
  window.addEventListener(CHANGE_EVENT, onCustom)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onCustom)
    window.removeEventListener('storage', onStorage)
  }
}

/** A fresh unguessable id for one sign-in attempt: this tab's secret for collecting the result. */
const newFlowId = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, '-').replace(/\//g, '_')

const POLL_MS = 1500
/** Matches the Worker's lifetime for a pending authorization request. */
const SIGN_IN_PATIENCE_MS = 10 * 60 * 1000

let cancelPending: (() => void) | null = null

/**
 * Opens the Worker's sign-in popup and resolves with the session it hands back. Call it directly from a click handler
 * (popup blockers). The result arrives by `postMessage` (accepted only from the Worker origin AND the popup we opened) or,
 * when the provider's page severed `window.opener` (Bluesky's does), by polling the Worker with this attempt's secret id.
 * Calling it again abandons an attempt that is still waiting.
 */
export function signIn(api: string, provider?: string): Promise<StoredSession> {
  const a = normalize(api)
  const apiOrigin = new URL(a).origin
  const flowId = newFlowId()
  // Without a provider the popup shows the chooser (or goes straight to the only provider); `provider` bypasses it.
  const url = `${apiOrigin}/api/contrib/auth/start?${provider ? `provider=${encodeURIComponent(provider)}&` : ''}o=${encodeURIComponent(location.origin)}&r=${flowId}`
  const popup = window.open(url, 'cms-signin', 'popup=yes,width=520,height=720')
  if (!popup) return Promise.reject(new SignInError('popup_blocked'))
  cancelPending?.()
  return new Promise<StoredSession>((resolve, reject) => {
    let done = false
    let timer: ReturnType<typeof setTimeout>
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(deadline)
      window.removeEventListener('message', onMessage)
      if (cancelPending === cancel) cancelPending = null
      fn()
    }
    const cancel = () => finish(() => reject(new SignInError('closed')))
    const settle = (m: ContribAuthMessage | null | undefined) => {
      if (m?.type === 'cms-contrib' && typeof m.token === 'string' && m.user && typeof m.user.id === 'string') {
        const s: StoredSession = { token: m.token, user: { id: m.user.id, displayName: m.user.displayName, image: m.user.image ?? null } }
        writeSession(a, s)
        finish(() => resolve(s))
      } else if (m?.type === 'cms-contrib-error') {
        finish(() => reject(new SignInError(m.code, m.eligibleAt ?? null)))
      }
    }
    const onMessage = (e: MessageEvent) => {
      if (e.origin === apiOrigin && e.source === popup) settle(e.data as ContribAuthMessage | null)
    }
    // `popup.closed` cannot be trusted: once the provider's page severs the opener (COOP) it reads true while the user is still
    // signing in. So keep asking the Worker until it answers, another sign-in starts, or the attempt expires.
    const poll = () => {
      fetch(`${apiOrigin}/api/contrib/auth/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ r: flowId }), cache: 'no-store' })
        .then((res) => (res.ok ? (res.json() as Promise<{ message?: ContribAuthMessage }>) : null))
        .then((j) => settle(j?.message))
        .catch(() => {})
        .finally(() => {
          if (!done) timer = setTimeout(poll, POLL_MS)
        })
    }
    timer = setTimeout(poll, POLL_MS)
    const deadline = setTimeout(cancel, SIGN_IN_PATIENCE_MS)
    cancelPending = cancel
    window.addEventListener('message', onMessage)
  })
}
