import { and, eq, gt } from 'drizzle-orm'
import type { MiddlewareHandler } from 'hono'
import { CONTRIB_TOKEN_TTL_MS, DISPLAY_NAME_MAX, DISPLAY_NAME_MIN, HOUR_MS } from '../config.ts'
import type { Env } from '../env.ts'
import { TYPE_DEFS } from '../types/index.ts'
import { getDb } from './db/client.ts'
import { contrib_token_tab, contributor_tab, user_tab } from './db/schema.ts'
import { apiError, sha256Hex, type AppEnv } from './http.ts'
import { getType } from './types-runtime.ts'

// Contributor bearer tokens are deliberately NOT BetterAuth sessions: /api/admin/* only ever reads the
// BetterAuth cookie, so a token that leaks from a wiki page can never act as a moderator.

export interface ContributorCtx {
  id: string
  displayName: string
  image: string | null
}

declare module 'hono' {
  interface ContextVariableMap {
    contributor: ContributorCtx
    contribTokenHash: string
  }
}

export const TOKEN_PREFIX = 'cct_'

export function newContribToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return TOKEN_PREFIX + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const hashContribToken = (token: string): Promise<string> => sha256Hex(token)

/** Creates a token row and returns the raw token (shown once, never stored). */
export async function mintContribToken(env: Env, userId: string, origin: string, now: number): Promise<string> {
  const token = newContribToken()
  await getDb(env).insert(contrib_token_tab).values({
    tokenHash: await hashContribToken(token),
    userId,
    origin,
    createdAt: now,
    expiresAt: now + CONTRIB_TOKEN_TTL_MS,
    lastUsedAt: now,
  })
  return token
}

/** Trimmed, whitespace-collapsed, no control/format characters; null when out of range. */
export function normalizeDisplayName(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const s = input.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim()
  const len = [...s].length
  return len >= DISPLAY_NAME_MIN && len <= DISPLAY_NAME_MAX ? s : null
}

/** Origins that may call the contributor API: the union of every enabled type's `allowed_origins`. */
export async function allowedContribOrigins(env: Env): Promise<Set<string>> {
  const out = new Set<string>()
  for (const def of TYPE_DEFS) {
    const rt = await getType(env, def.id)
    for (const o of rt?.allowedOrigins ?? []) out.add(o)
  }
  return out
}

const CORS_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS'

/**
 * CORS for /api/contrib/*: only allowed wiki origins, `Authorization` header, never credentials (cookies are ignored here).
 * Handles the preflight itself. Requests without an allowed Origin are refused.
 */
export const contribCors: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header('Origin')
  if (!origin || !(await allowedContribOrigins(c.env)).has(origin)) return apiError(c, 403, 'bad_origin', 'Origin not allowed.')
  c.header('Access-Control-Allow-Origin', origin)
  c.header('Vary', 'Origin')
  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204, {
      'Access-Control-Allow-Methods': CORS_METHODS,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
    })
  }
  await next()
}

/** Bearer-only. Sets `contributor`. Cookies are never consulted (so no CSRF surface). */
export const requireContributor: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = (c.req.header('Authorization') ?? '').match(/^Bearer (cct_[A-Za-z0-9_-]{20,100})$/)
  if (!m) return apiError(c, 401, 'unauthenticated', 'Sign in required.')
  const now = c.get('deps').now()
  const db = getDb(c.env)
  const tokenHash = await hashContribToken(m[1]!)
  const row = await db
    .select({
      id: user_tab.id,
      image: user_tab.image,
      displayName: contributor_tab.displayName,
      lastUsedAt: contrib_token_tab.lastUsedAt,
    })
    .from(contrib_token_tab)
    .innerJoin(contributor_tab, eq(contributor_tab.userId, contrib_token_tab.userId))
    .innerJoin(user_tab, eq(user_tab.id, contrib_token_tab.userId))
    .where(and(eq(contrib_token_tab.tokenHash, tokenHash), gt(contrib_token_tab.expiresAt, now)))
    .get()
  if (!row) return apiError(c, 401, 'unauthenticated', 'Sign in required.')
  // Touch at most hourly: this feeds the idle-account prune, not security.
  if (now - row.lastUsedAt > HOUR_MS) {
    c.executionCtx.waitUntil(db.update(contrib_token_tab).set({ lastUsedAt: now }).where(eq(contrib_token_tab.tokenHash, tokenHash)).run().then(() => undefined))
  }
  c.set('contributor', { id: row.id, displayName: row.displayName, image: row.image })
  c.set('contribTokenHash', tokenHash)
  await next()
}

