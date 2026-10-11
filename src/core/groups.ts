import type { Env } from '../env.ts'
import type { GroupInfo } from './types-registry.ts'
import type { ResolvedType } from './types-runtime.ts'

export interface RegistryEntry {
  title: string
  url: string
  options?: Record<string, unknown>
}
export interface Registry {
  groups: Record<string, RegistryEntry>
}
interface Stored {
  fetchedAt: number
  hash: string
  data: Registry
}

const MEMO_TTL_MS = 5 * 60_000
const UNKNOWN_REFETCH_AFTER_MS = 10 * 60_000
const REFETCH_THROTTLE_MS = 60_000

interface Memo {
  at: number
  stored: Stored
}
const memo = new Map<string, Memo>()
const lastRefetch = new Map<string, number>()
const rosterMemo = new Map<string, { at: number; data: unknown }>()

export function clearGroupCaches(): void {
  memo.clear()
  lastRefetch.clear()
  rosterMemo.clear()
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function isRegistry(v: unknown): v is Registry {
  if (typeof v !== 'object' || v === null) return false
  const g = (v as Registry).groups
  return typeof g === 'object' && g !== null && !Array.isArray(g)
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

async function readStored(env: Env, key: string): Promise<Stored | null> {
  try {
    return await env.KV.get<Stored>(key, { type: 'json', cacheTtl: 60 })
  } catch {
    return null
  }
}

const groupsKey = (t: string) => `groups:${t}`
const rosterKey = (t: string) => `roster:${t}`

export interface RefreshResult {
  fetched: boolean
  changed: boolean
  /** Group ids whose `options` differ from the previous copy (they need republishing). */
  optionsChanged: string[]
}

/** Fetch the wiki's registry; write KV only when the content hash changed. */
export async function refreshGroups(env: Env, typeId: string, rt: ResolvedType, now = Date.now()): Promise<RefreshResult> {
  lastRefetch.set(typeId, now)
  const text = await fetchText(rt.groupsUrl)
  if (text === null) return { fetched: false, changed: false, optionsChanged: [] }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { fetched: false, changed: false, optionsChanged: [] }
  }
  if (!isRegistry(data)) return { fetched: false, changed: false, optionsChanged: [] }
  const hash = await sha256Hex(text)
  const prev = memo.get(typeId)?.stored ?? (await readStored(env, groupsKey(typeId)))
  const stored: Stored = { fetchedAt: now, hash, data }
  const changed = !prev || prev.hash !== hash
  if (changed) {
    try {
      await env.KV.put(groupsKey(typeId), JSON.stringify(stored))
    } catch (e) {
      console.warn('groups registry KV write failed', e)
    }
  }
  memo.set(typeId, { at: now, stored })
  const optionsChanged: string[] = []
  if (prev && changed) {
    for (const [id, entry] of Object.entries(data.groups)) {
      const before = prev.data.groups[id]
      if (before && JSON.stringify(before.options ?? {}) !== JSON.stringify(entry.options ?? {})) optionsChanged.push(id)
    }
  }
  return { fetched: true, changed, optionsChanged }
}

async function getStored(env: Env, typeId: string, rt: ResolvedType, now: number): Promise<Stored | null> {
  const m = memo.get(typeId)
  if (m && now - m.at < MEMO_TTL_MS) return m.stored
  const kv = await readStored(env, groupsKey(typeId))
  if (kv) {
    memo.set(typeId, { at: now, stored: kv })
    return kv
  }
  await refreshGroups(env, typeId, rt, now)
  return memo.get(typeId)?.stored ?? null
}

/** Look up one group. An unknown group triggers a throttled refetch when the cached copy is old. */
export async function getGroup(
  env: Env,
  typeId: string,
  rt: ResolvedType,
  groupId: string,
  now = Date.now(),
): Promise<GroupInfo | null> {
  let stored = await getStored(env, typeId, rt, now)
  let entry = stored?.data.groups[groupId]
  if (!entry && stored && now - stored.fetchedAt > UNKNOWN_REFETCH_AFTER_MS && now - (lastRefetch.get(typeId) ?? 0) > REFETCH_THROTTLE_MS) {
    await refreshGroups(env, typeId, rt, now)
    stored = memo.get(typeId)?.stored ?? stored
    entry = stored.data.groups[groupId]
  }
  if (!entry) return null
  return { id: groupId, title: entry.title, url: entry.url, options: entry.options ?? {} }
}

/** All groups of a type (admin). */
export async function listGroups(env: Env, typeId: string, rt: ResolvedType, now = Date.now()): Promise<GroupInfo[]> {
  const stored = await getStored(env, typeId, rt, now)
  if (!stored) return []
  return Object.entries(stored.data.groups).map(([id, e]) => ({ id, title: e.title, url: e.url, options: e.options ?? {} }))
}

// ---- roster (soft existence check for stock ids) ----

const ROSTER_MEMO_TTL_MS = 60 * 60_000

function rosterUrl(rt: ResolvedType): string | null {
  if (!rt.def.rosterPath) return null
  try {
    return new URL(rt.def.rosterPath, rt.groupsUrl).toString()
  } catch {
    return null
  }
}

/** Fetch the roster and write KV only when its hash changed. Returns whether it was fetched. */
export async function refreshRoster(env: Env, typeId: string, rt: ResolvedType, now = Date.now()): Promise<boolean> {
  const url = rosterUrl(rt)
  if (!url) return false
  const text = await fetchText(url)
  if (text === null) return false
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return false
  }
  const hash = await sha256Hex(text)
  const prev = await readStored(env, rosterKey(typeId))
  if (!prev || prev.hash !== hash) {
    try {
      await env.KV.put(rosterKey(typeId), JSON.stringify({ fetchedAt: now, hash, data }))
    } catch (e) {
      console.warn('roster KV write failed', e)
    }
  }
  rosterMemo.set(typeId, { at: now, data })
  return true
}

/** Roster JSON or undefined if unavailable (callers must treat the check as optional). */
export async function getRoster(env: Env, typeId: string, rt: ResolvedType, now = Date.now()): Promise<unknown> {
  if (!rt.def.rosterPath) return undefined
  const m = rosterMemo.get(typeId)
  if (m && now - m.at < ROSTER_MEMO_TTL_MS) return m.data
  const kv = await readStored(env, rosterKey(typeId))
  if (kv) {
    rosterMemo.set(typeId, { at: now, data: kv.data })
    return kv.data
  }
  return undefined
}
