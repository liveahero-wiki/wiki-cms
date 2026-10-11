import { useEffect, useState } from 'preact/hooks'
import type { MeResponse } from '../../src/shared/api-types.ts'
import { ApiError, api, authHooks, raw } from './api.ts'

export type Session =
  | { status: 'loading' }
  | { status: 'out' }
  | { status: 'in'; me: MeResponse }
  | { status: 'error'; message: string }

let session: Session = { status: 'loading' }
const listeners = new Set<() => void>()
const set = (s: Session) => {
  session = s
  listeners.forEach((l) => l())
}

authHooks.onUnauthorized = () => {
  if (session.status === 'in') set({ status: 'out' })
}

export async function refreshSession() {
  try {
    set({ status: 'in', me: await api.get<MeResponse>('/me', { quiet401: true }) })
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) set({ status: 'out' })
    else set({ status: 'error', message: e instanceof Error ? e.message : 'Could not load your session.' })
  }
}

export async function signOut() {
  try {
    await raw.post('/api/auth/sign-out', {})
  } catch {
    /* the cookie may already be gone */
  }
  set({ status: 'out' })
}

/** Starts the Discord OAuth flow; the browser returns to `callbackPath` afterwards. */
export async function signInWithDiscord(callbackPath: string) {
  const res = await raw.post<{ url?: string; redirect?: boolean }>('/api/auth/sign-in/social', { provider: 'discord', callbackURL: callbackPath })
  if (!res.url) throw new Error('Sign-in is not available right now.')
  location.href = res.url
}

export function useSession(): Session {
  const [, bump] = useState(0)
  useEffect(() => {
    const l = () => bump((n) => n + 1)
    listeners.add(l)
    return () => void listeners.delete(l)
  }, [])
  return session
}
