import { BSKY_PROFILE_TIMEOUT_MS, PLC_TIMEOUT_MS } from '../config.ts'
import { normalizeDisplayName } from './contrib-auth.ts'
import { ProviderUnavailable } from './provider-error.ts'

// Unauthenticated Bluesky lookups used at sign-in. No @atproto/* imports here (see atproto.ts for the OAuth client).

export const PLC_DID_RE = /^did:plc:[a-z2-7]{24}$/
/** Lower-case DNS-style handle (the form `normalizeHandleInput` produces). */
export const HANDLE_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const DID_RE = /^did:[a-z]+:[a-z0-9._:%-]{1,2000}$/

/**
 * What the user typed in the handle field → `alice.bsky.social` or a DID; null when it can be neither.
 * Trims, drops invisible direction marks (copy/paste from the app adds them), a leading `@` and `at://`.
 */
export function normalizeHandleInput(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const s = input
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '')
    .trim()
    .replace(/^at:\/\//i, '')
    .replace(/^@/, '')
    .trim()
    .toLowerCase()
  if (!s || s.length > 253) return null
  return DID_RE.test(s) || HANDLE_RE.test(s) ? s : null
}

/**
 * When the PLC directory first saw this DID (the first operation of its audit log). The directory timestamps it, so the user
 * cannot backdate it. Anything other than a well-formed log ⇒ ProviderUnavailable (fail closed, never "too young").
 */
export async function plcCreatedAt(did: string): Promise<number> {
  if (!PLC_DID_RE.test(did)) throw new ProviderUnavailable('not a did:plc')
  let res: Response
  try {
    res = await fetch(`https://plc.directory/${did}/log/audit`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(PLC_TIMEOUT_MS) })
  } catch (e) {
    throw new ProviderUnavailable('PLC directory unreachable', { cause: e })
  }
  if (res.status !== 200) {
    res.body?.cancel()
    throw new ProviderUnavailable(`PLC directory answered ${res.status}`)
  }
  let log: unknown
  try {
    log = await res.json()
  } catch (e) {
    throw new ProviderUnavailable('PLC audit log is not JSON', { cause: e })
  }
  if (!Array.isArray(log) || log.length === 0) throw new ProviderUnavailable('PLC audit log is empty')
  let earliest = Infinity
  for (const entry of log) {
    const at = typeof (entry as { createdAt?: unknown })?.createdAt === 'string' ? Date.parse((entry as { createdAt: string }).createdAt) : NaN
    if (!Number.isFinite(at)) throw new ProviderUnavailable('PLC audit log entry without a valid createdAt')
    earliest = Math.min(earliest, at)
  }
  return earliest
}

export interface BskyProfile {
  displayName: string
  image: string | null
  /** Null when the account has no (valid) handle. Moderators only. */
  handle: string | null
}

const FALLBACK_NAME = 'Contributor'

/** Display name / avatar / handle from the public AppView; any failure yields defaults (sign-in must not depend on it). */
export async function fetchBskyProfile(did: string): Promise<BskyProfile> {
  let raw: { displayName?: unknown; avatar?: unknown; handle?: unknown } = {}
  try {
    const res = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(BSKY_PROFILE_TIMEOUT_MS),
    })
    if (res.status === 200) {
      const j = await res.json()
      if (j && typeof j === 'object') raw = j
    } else res.body?.cancel()
  } catch {
    // defaults below
  }
  const handle = typeof raw.handle === 'string' && raw.handle !== 'handle.invalid' && HANDLE_RE.test(raw.handle.toLowerCase()) ? raw.handle.toLowerCase() : null
  const name = normalizeDisplayName(raw.displayName) ?? (handle ? normalizeDisplayName(handle.split('.')[0]) : null) ?? FALLBACK_NAME
  // The avatar ends up in an <img src> on the wiki: only Bluesky's CDN.
  const image = typeof raw.avatar === 'string' && raw.avatar.length <= 500 && raw.avatar.startsWith('https://cdn.bsky.app/') ? raw.avatar : null
  return { displayName: name, image, handle }
}
