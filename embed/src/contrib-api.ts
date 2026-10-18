// Calls to the bearer-only contributor API (`/api/contrib/*`). Loaded lazily (form chunk, or on first use by a host page).
import type {
  ContribEditRequest,
  ContribEditResponse,
  ContribMeResponse,
  ContribSubmission,
  ContribSubmissionsResponse,
  ContribSubmitRequest,
  ContribUser,
} from '../../src/shared/api-types.ts'
import { currentSession, writeSession } from './contrib-session.ts'
import { ApiError, readError } from './shared.ts'

async function call<T>(api: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const base = api.replace(/\/+$/, '')
  const session = currentSession(base)
  if (!session) throw new ApiError(401, 'unauthenticated', 'Sign in required.')
  let res: Response
  try {
    res = await fetch(`${base}/api/contrib${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${session.token}`, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    })
  } catch {
    throw new ApiError(0, 'network', 'Network error')
  }
  if (res.status === 401) {
    writeSession(base, null) // expired or revoked token: forget it so the UI asks to sign in again
    throw new ApiError(401, 'unauthenticated', 'Sign in required.')
  }
  if (!res.ok) throw await readError(res)
  return (await res.json()) as T
}

const enc = encodeURIComponent

export async function mine(api: string, type?: string): Promise<ContribSubmission[]> {
  return (await call<ContribSubmissionsResponse>(api, `/submissions${type ? `?type=${enc(type)}` : ''}`)).items
}

export function createSubmission(api: string, type: string, group: string, body: ContribSubmitRequest) {
  return call<{ id: string; state: 'pending'; version: number }>(api, `/submissions/${enc(type)}/${enc(group)}`, { method: 'POST', body })
}

export function editSubmission(api: string, id: string, body: ContribEditRequest) {
  return call<ContribEditResponse>(api, `/submissions/${enc(id)}`, { method: 'PUT', body })
}

export async function withdrawRevision(api: string, id: string): Promise<void> {
  await call(api, `/submissions/${enc(id)}/revision`, { method: 'DELETE' })
}

export async function rename(api: string, displayName: string): Promise<ContribUser> {
  const { user } = await call<ContribMeResponse>(api, '/me', { method: 'PATCH', body: { displayName } })
  const s = currentSession(api)
  if (s) writeSession(api, { ...s, user })
  return user
}

/** Revokes the token on the server (best effort) and forgets it locally. */
export async function signOut(api: string): Promise<void> {
  try {
    await call(api, '/auth/signout', { method: 'POST', body: {} })
  } catch {
    /* already gone, or offline: the local session is dropped either way */
  }
  writeSession(api, null)
}
