import { env } from 'cloudflare:workers'
import { vi, type Mock } from 'vitest'
import type { Purger } from '../src/core/cache.ts'
import { createApp } from '../src/core/app.ts'
import { hashContribToken, newContribToken } from '../src/core/contrib-auth.ts'
import { clearGroupCaches } from '../src/core/groups.ts'
import { clearTypeCache } from '../src/core/types-runtime.ts'
import type { Deps } from '../src/core/http.ts'

export const TYPE = 'lah-team-formation'
export const ORIGIN = 'http://localhost:8080'
export const GROUPS_URL = 'https://wiki.test/api/cms-groups.json'

export const REGISTRY = {
  groups: {
    'quest-1': { title: 'Event › SS', url: '/e/#team-quest-1', options: { support: false } },
    'quest-2': { title: 'Event › S', url: '/e/#team-quest-2' },
    all: {
      title: 'Team Creator',
      url: '/team-creator.html',
      options: {
        support: 'optional',
        targets: [
          { id: 'quest-616001', label: { en: 'Simulator (SSS)' }, url: '/guide/challenge_simulator/' },
          { id: 'quest-605001', label: { en: 'Old simulator' }, retired: true },
        ],
      },
    },
    'hero-10251': {
      title: 'Andrew – Hero',
      url: '/charas/andrew/#team-hero-10251',
      options: { support: true, focus: { kind: 'hero', stockId: 10251 } },
    },
  },
}

export interface Harness {
  purge: Mock<Purger>
  app: ReturnType<typeof createApp>
  fetch(path: string, init?: RequestInit): Promise<Response>
  /** Awaits everything passed to ctx.waitUntil so far. */
  settle(): Promise<void>
}

export const ALLOW_ALL = { limit: async () => ({ success: true }) }

export function makeHarness(over: Partial<Deps> = {}, envOver: Record<string, unknown> = {}): Harness {
  const purge = vi.fn<Purger>(async () => ({ success: true, errors: [] }))
  const app = createApp({ purge, ...over })
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext
  return {
    purge,
    app,
    settle: async () => void (await Promise.allSettled(pending.splice(0))),
    fetch: (path, init) => Promise.resolve(app.fetch(new Request('http://localhost:8787' + path, init), { ...env, SUBMIT_LIMITER: ALLOW_ALL, ...envOver } as typeof env, ctx)),
  }
}

/** Calls the fetch stub received for Discord webhooks; `discordStatus.value` = response status (0 = network error). */
export const discordCalls: { url: string; body: { content: string; allowed_mentions: unknown } }[] = []
export const discordStatus = { value: 204 }

/** Extra JSON documents the fetch stub serves (url -> body), e.g. rosters; cleared by `resetState`. */
export const extraFetch = new Map<string, unknown>()

/** Inserts an enabled type config row (groups registry = GROUPS_URL, allowed origin = ORIGIN) and drops the type memo. */
export async function seedType(id: string, over: { submitAuth?: 'anonymous' | 'account'; name?: string } = {}) {
  await env.DB.prepare('INSERT INTO submission_type_tab (id,name,enabled,allowed_origins,plugin_url,groups_url,submit_auth,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(id, over.name ?? id, 1, JSON.stringify([ORIGIN]), `${ORIGIN}/assets/cms/${id}.js`, GROUPS_URL, over.submitAuth ?? 'anonymous', 1)
    .run()
  clearTypeCache()
}

/** Reset D1/KV state and module caches, then (re)seed the type row and stub outbound fetch. */
export async function resetState(opts: { turnstile?: boolean; registry?: unknown } = {}) {
  clearGroupCaches()
  clearTypeCache()
  for (const t of ['submission_revision_tab', 'contrib_token_tab', 'contributor_tab', 'submission_tab', 'moderator_permission_tab', 'invite_tab', 'ip_block_tab', 'audit_log_tab', 'session_tab', 'account_tab', 'verification_tab', 'user_tab', 'submission_type_tab']) {
    await env.DB.prepare(`DELETE FROM ${t}`).run()
  }
  const keys = await env.KV.list()
  for (const k of keys.keys) await env.KV.delete(k.name)
  await env.DB.prepare(
    'INSERT INTO submission_type_tab (id,name,enabled,allowed_origins,plugin_url,groups_url,created_at) VALUES (?,?,?,?,?,?,?)',
  )
    .bind(TYPE, 'LAH team formation', 1, JSON.stringify([ORIGIN]), `${ORIGIN}/assets/cms/p.js`, GROUPS_URL, 1)
    .run()
  const turnstileOk = opts.turnstile ?? true
  discordCalls.length = 0
  discordStatus.value = 204
  extraFetch.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('https://discord.com/api/webhooks/')) {
        discordCalls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) })
        if (discordStatus.value === 0) throw new Error('network down')
        return new Response(null, { status: discordStatus.value })
      }
      if (url === GROUPS_URL) return new Response(JSON.stringify(opts.registry ?? REGISTRY), { headers: { 'content-type': 'application/json' } })
      if (extraFetch.has(url)) return new Response(JSON.stringify(extraFetch.get(url)), { headers: { 'content-type': 'application/json' } })
      if (url.startsWith('https://challenges.cloudflare.com/')) {
        return new Response(JSON.stringify({ success: turnstileOk }))
      }
      return new Response('not found', { status: 404 })
    }),
  )
}

export const goodTeam = (extra: Record<string, unknown> = {}) => ({
  v: 1,
  supportIndex: null,
  heroes: [{ stockId: 10011 }, { stockId: 10021 }],
  ...extra,
})

export function submitBody(over: Record<string, unknown> = {}) {
  return {
    payload: goodTeam(),
    title: 'Test team',
    tags: { teamType: 'manual', successRate: 'high' },
    lang: 'en',
    explanation: '## Overview\nWorks.',
    demoUrl: 'https://youtu.be/abc',
    turnstileToken: 'tok',
    website: '',
    ...over,
  }
}

export function post(h: Harness, group: string, body: unknown, headers: Record<string, string> = {}) {
  return h.fetch(`/api/v1/submissions/${TYPE}/${group}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.9', ...headers },
    body: JSON.stringify(body),
  })
}

export async function rows(where = '1=1') {
  const r = await env.DB.prepare(`SELECT * FROM submission_tab WHERE ${where} ORDER BY created_at`).all<Record<string, unknown>>()
  return r.results
}

// ---- contributor accounts ----
export const DAY = 86_400_000

/** A Discord snowflake whose embedded creation time is `ms`. */
export const snowflakeAt = (ms: number): string => ((BigInt(ms) - 1420070400000n) << 22n).toString()

async function hmacSigned(value: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  let bin = ''
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b)
  return encodeURIComponent(`${value}.${btoa(bin)}`)
}

/** Creates a user (+ optional permissions, Discord account) and a real BetterAuth session; returns the Cookie header value. */
export async function sessionCookie(userId: string, opts: { types?: string[]; discordId?: string } = {}): Promise<string> {
  const now = Date.now()
  await env.DB.prepare('INSERT OR IGNORE INTO user_tab (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(userId, `User ${userId}`, `${userId}@users.invalid`, 0, now, now).run()
  for (const t of opts.types ?? []) {
    await env.DB.prepare('INSERT OR IGNORE INTO moderator_permission_tab (user_id,type,granted_by,created_at) VALUES (?,?,?,?)').bind(userId, t, null, now).run()
  }
  if (opts.discordId) {
    await env.DB.prepare('INSERT OR IGNORE INTO account_tab (id,account_id,provider_id,user_id,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(`acc-${userId}`, opts.discordId, 'discord', userId, now, now).run()
  }
  const token = `tok-${userId}-${crypto.randomUUID()}`
  await env.DB.prepare('INSERT INTO session_tab (id,expires_at,token,created_at,updated_at,user_id) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(), now + DAY, token, now, now, userId).run()
  return `better-auth.session_token=${await hmacSigned(token, env.BETTER_AUTH_SECRET)}`
}

/** Creates a contributor (user + profile) with a live bearer token; returns the raw token. */
export async function contribLogin(userId: string, opts: { displayName?: string; now?: number; expiresAt?: number } = {}): Promise<string> {
  const now = opts.now ?? Date.now()
  await env.DB.prepare('INSERT OR IGNORE INTO user_tab (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(userId, `User ${userId}`, `${userId}@users.invalid`, 0, now, now).run()
  await env.DB.prepare('INSERT OR IGNORE INTO contributor_tab (user_id,display_name,trust_level,created_at) VALUES (?,?,0,?)').bind(userId, opts.displayName ?? `Contributor ${userId}`, now).run()
  const token = newContribToken()
  await env.DB.prepare('INSERT INTO contrib_token_tab (token_hash,user_id,origin,created_at,expires_at,last_used_at) VALUES (?,?,?,?,?,?)')
    .bind(await hashContribToken(token), userId, ORIGIN, now, opts.expiresAt ?? now + 30 * DAY, now)
    .run()
  return token
}

export function contribApi(h: Harness, token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return h.fetch(`/api/contrib${path}`, {
    method,
    headers: {
      Origin: ORIGIN,
      'CF-Connecting-IP': '203.0.113.77',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}
