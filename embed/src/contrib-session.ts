// Contributor sign-in for the embed. Dependency-free on purpose: the tiny loader (`v1.js`) imports it, so a wiki page can
// check "am I signed in?" and open the popup (which must happen synchronously inside a click) without loading Preact.
//
// The session is a bearer token the Worker's popup page posts to this window. It lives in `localStorage` of the WIKI origin
// (not the Worker's), under `cms-contrib:<api origin>`. It is only ever sent to `/api/contrib/*`, which accepts no cookies.
import type { ContribAuthMessage, ContribUser } from '../../src/shared/api-types.ts'

export interface StoredSession {
  token: string
  user: ContribUser
  /** Set by a first sign-in that still needs a display name; cleared by `rename`. */
  needsDisplayName?: true
}

export type SignInErrorCode = 'popup_blocked' | 'closed' | 'account_too_young' | 'unauthenticated' | 'unavailable'

export class SignInError extends Error {
  constructor(
    public code: SignInErrorCode,
    public eligibleAt: number | null = null,
    /** The provider whose popup failed, when known. */
    public provider: string | null = null,
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
    return { token: s.token, user: { id: s.user.id, displayName: s.user.displayName, image: s.user.image ?? null }, ...(s.needsDisplayName ? { needsDisplayName: true as const } : {}) }
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

export interface SignInOptions {
  /** Open this provider's popup straight away (synchronously, so call it inside a click). Omit to show the provider picker. */
  provider?: string
  /** UI language of the picker and the name dialog (a Lang or a BCP-47 tag); default: resolved from the page. */
  lang?: string
}

const lastKey = (api: string) => `cms-contrib-provider:${api}`

/** The provider this browser last signed in with on this wiki-cms, or null. */
export function readLastProvider(api: string): string | null {
  try {
    return localStorage.getItem(lastKey(normalize(api)))
  } catch {
    return null
  }
}

function writeLastProvider(api: string, provider: string): void {
  try {
    localStorage.setItem(lastKey(api), provider)
  } catch {
    /* storage unavailable: the picker just has no preselection */
  }
}

/** Used when the provider list cannot be fetched: Discord has always been available. */
const FALLBACK_PROVIDERS = [{ id: 'discord', label: 'Discord' }]

async function fetchProviders(apiOrigin: string): Promise<{ id: string; label: string }[]> {
  try {
    const res = await fetch(`${apiOrigin}/api/contrib/auth/providers`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return FALLBACK_PROVIDERS
    const list = ((await res.json()) as { providers?: { id?: unknown; label?: unknown }[] }).providers
    const out = (list ?? []).filter((p): p is { id: string; label: string } => typeof p.id === 'string' && typeof p.label === 'string')
    return out.length ? out : FALLBACK_PROVIDERS
  } catch {
    return FALLBACK_PROVIDERS
  }
}

/**
 * Signs in through the Worker's popup and resolves with the session it posts back. Without `provider` a picker dialog
 * (lazy chunk, shadow DOM) lists the providers first, the last used one first; the popup then opens from the click on a
 * provider button. With `provider` the popup opens synchronously, so call it directly from a click handler (popup
 * blockers). A string second argument is the old `provider` parameter. After a first sign-in with a provider that
 * returns a real name, a dialog asks for a display name before this resolves (closing it keeps "Contributor").
 */
export async function signIn(api: string, options?: string | SignInOptions): Promise<StoredSession> {
  const o = typeof options === 'string' ? { provider: options } : (options ?? {})
  const a = normalize(api)
  let provider = o.provider
  if (!provider) {
    const [list, dialogs] = await Promise.all([fetchProviders(new URL(a).origin), import('./dialogs.ts')])
    const picked = await dialogs.pickProvider({ providers: list, last: readLastProvider(a), lang: o.lang })
    if (!picked) throw new SignInError('closed')
    provider = picked
  }
  const session = await popupSignIn(a, provider)
  writeLastProvider(a, provider)
  if (!session.needsDisplayName) return session
  await (await import('./dialogs.ts')).askDisplayName({ api: a, lang: o.lang })
  return currentSession(a) ?? session
}

/**
 * Providers whose own sign-in pages send a `Cross-Origin-Opener-Policy`: once the popup has been there it has no
 * `window.opener` any more and `popup.closed` reads true while the user is still signing in (Google does this; Discord does not).
 */
const SEVERS_OPENER = new Set(['google'])

/** A fresh unguessable id for one sign-in attempt: this tab's secret for collecting the result by polling. */
const newFlowId = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, '-').replace(/\//g, '_')

const POLL_MS = 1500
/** Longest wait for a sign-in whose popup cannot be watched; the Worker keeps a result for far less than that. */
const SIGN_IN_PATIENCE_MS = 10 * 60 * 1000

let cancelPending: (() => void) | null = null

/**
 * Opens the Worker's sign-in popup for `provider`. The result arrives by `postMessage` (accepted only from the Worker origin
 * AND the popup we opened) or, for providers that sever `window.opener`, by polling the Worker with this attempt's secret id.
 * Such a popup cannot be watched for closing, so starting another sign-in is how the user abandons a wait (the old call
 * rejects with `closed`).
 */
function popupSignIn(a: string, provider: string): Promise<StoredSession> {
  const apiOrigin = new URL(a).origin
  const polled = SEVERS_OPENER.has(provider)
  const flowId = polled ? newFlowId() : null
  const url = `${apiOrigin}/api/contrib/auth/start?provider=${encodeURIComponent(provider)}&o=${encodeURIComponent(location.origin)}${flowId ? `&r=${flowId}` : ''}`
  const popup = window.open(url, 'cms-signin', 'popup=yes,width=520,height=720')
  if (!popup) return Promise.reject(new SignInError('popup_blocked', null, provider))
  cancelPending?.()
  return new Promise<StoredSession>((resolve, reject) => {
    let done = false
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let closedTimer: ReturnType<typeof setInterval> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(pollTimer)
      clearInterval(closedTimer)
      clearTimeout(deadline)
      window.removeEventListener('message', onMessage)
      if (cancelPending === cancel) cancelPending = null
      fn()
    }
    const cancel = () => finish(() => reject(new SignInError('closed', null, provider)))
    const settle = (m: ContribAuthMessage | null | undefined) => {
      if (m?.type === 'cms-contrib' && typeof m.token === 'string' && m.user && typeof m.user.id === 'string') {
        const s: StoredSession = {
          token: m.token,
          user: { id: m.user.id, displayName: m.user.displayName, image: m.user.image ?? null },
          ...(m.needsDisplayName ? { needsDisplayName: true as const } : {}),
        }
        writeSession(a, s)
        finish(() => resolve(s))
      } else if (m?.type === 'cms-contrib-error') {
        finish(() => reject(new SignInError(m.code, m.eligibleAt ?? null, provider)))
      }
    }
    const onMessage = (e: MessageEvent) => {
      if (e.origin === apiOrigin && e.source === popup) settle(e.data as ContribAuthMessage | null)
    }
    window.addEventListener('message', onMessage)
    cancelPending = cancel
    if (flowId) {
      const poll = () => {
        fetch(`${apiOrigin}/api/contrib/auth/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ r: flowId }), cache: 'no-store' })
          .then((res) => (res.ok ? (res.json() as Promise<{ message?: ContribAuthMessage }>) : null))
          .then((j) => settle(j?.message))
          .catch(() => {})
          .finally(() => {
            if (!done) pollTimer = setTimeout(poll, POLL_MS)
          })
      }
      pollTimer = setTimeout(poll, POLL_MS)
      deadline = setTimeout(cancel, SIGN_IN_PATIENCE_MS)
    } else {
      // The popup closes itself shortly after posting; a message always arrives before `closed` flips.
      closedTimer = setInterval(() => popup.closed && cancel(), 500)
    }
  })
}
