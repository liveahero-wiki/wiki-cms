import { and, count, eq, gte } from 'drizzle-orm'
import { DAY_MS, MAX_BODY_BYTES } from '../config.ts'
import { getDb } from './db/client.ts'
import { ip_block_tab, submission_revision_tab, submission_tab } from './db/schema.ts'
import { apiError, type Ctx } from './http.ts'
import { ipKey } from './ip.ts'
import { verifyTurnstile } from './turnstile.ts'
import type { ResolvedType } from './types-runtime.ts'

// Anti-abuse checks shared by the anonymous submit (routes/public.ts) and the contributor submit/edit (routes/contrib.ts).
// Keep the order cheap -> expensive at the call sites: origin, body, honeypot, ip block, rate limit, validation, Turnstile, caps.

export type Body = Record<string, unknown>

/** Reads a JSON object body under the size cap. */
export async function readBody(c: Ctx): Promise<{ ok: true; body: Body } | { ok: false; res: Response }> {
  const len = Number(c.req.header('Content-Length') ?? '0')
  if (len > MAX_BODY_BYTES) return { ok: false, res: apiError(c, 413, 'too_large', 'Request body too large.') }
  const raw = await c.req.text()
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return { ok: false, res: apiError(c, 413, 'too_large', 'Request body too large.') }
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
    return { ok: true, body: parsed as Body }
  } catch {
    return { ok: false, res: apiError(c, 400, 'bad_json', 'Invalid JSON body.') }
  }
}

/** True when the hidden `website` field is filled in (bots). Callers answer with a fake success. */
export function isHoneypot(body: Body): boolean {
  return typeof body.website === 'string' ? body.website !== '' : body.website !== undefined && body.website !== null
}

export interface ClientInfo {
  ip: string | null
  key: string
}

/** Blocklist + per-IP rate limiter. Returns the client identity, or an error response. */
export async function checkClient(c: Ctx): Promise<ClientInfo | Response> {
  const ip = c.req.header('CF-Connecting-IP') ?? null
  const key = (ip && ipKey(ip)) || 'unknown'
  if (await getDb(c.env).select({ k: ip_block_tab.ipKey }).from(ip_block_tab).where(eq(ip_block_tab.ipKey, key)).get()) {
    return apiError(c, 403, 'ip_blocked', 'Submissions from your network are currently blocked.')
  }
  const rl = await c.env.SUBMIT_LIMITER.limit({ key })
  if (!rl.success) return apiError(c, 429, 'rate_limited', 'Too many submissions, please try again in a minute.')
  return { ip, key }
}

/** Turnstile check (single-use token), hostnames limited to the type's allowed origins. */
export async function checkHuman(c: Ctx, rt: ResolvedType, body: Body, ip: string | null): Promise<Response | null> {
  const hostnames = rt.allowedOrigins.flatMap((o) => {
    try {
      return [new URL(o).hostname]
    } catch {
      return []
    }
  })
  const human = await verifyTurnstile({ secret: c.env.TURNSTILE_SECRET_KEY, token: body.turnstileToken, ip, allowedHostnames: hostnames, action: 'submit' })
  return human ? null : apiError(c, 403, 'turnstile_failed', 'Verification failed. Please try again.')
}

/** Submissions plus contributor edits waiting for review for a type. */
export async function countPending(c: Ctx, typeId: string): Promise<number> {
  const db = getDb(c.env)
  const [{ n: subs } = { n: 0 }] = await db
    .select({ n: count() })
    .from(submission_tab)
    .where(and(eq(submission_tab.type, typeId), eq(submission_tab.state, 'pending')))
  const [{ n: revs } = { n: 0 }] = await db
    .select({ n: count() })
    .from(submission_revision_tab)
    .innerJoin(submission_tab, eq(submission_tab.id, submission_revision_tab.submissionId))
    .where(and(eq(submission_tab.type, typeId), eq(submission_revision_tab.state, 'pending')))
  return subs + revs
}

/** Submissions + edits a contributor made for a type in the last 24 h. */
export async function countUserRecent(c: Ctx, userId: string, typeId: string, now: number): Promise<number> {
  const db = getDb(c.env)
  const since = now - DAY_MS
  const [{ n: subs } = { n: 0 }] = await db
    .select({ n: count() })
    .from(submission_tab)
    .where(and(eq(submission_tab.userId, userId), eq(submission_tab.type, typeId), gte(submission_tab.createdAt, since)))
  const [{ n: revs } = { n: 0 }] = await db
    .select({ n: count() })
    .from(submission_revision_tab)
    .innerJoin(submission_tab, eq(submission_tab.id, submission_revision_tab.submissionId))
    .where(and(eq(submission_revision_tab.userId, userId), eq(submission_tab.type, typeId), gte(submission_revision_tab.createdAt, since)))
  return subs + revs
}

export async function countIpRecent(c: Ctx, key: string, typeId: string, now: number): Promise<number> {
  const [{ n } = { n: 0 }] = await getDb(c.env)
    .select({ n: count() })
    .from(submission_tab)
    .where(and(eq(submission_tab.ipKey, key), eq(submission_tab.type, typeId), gte(submission_tab.createdAt, now - DAY_MS)))
  return n
}

export const countryOf = (c: Ctx): string | null => (c.req.raw as { cf?: { country?: string } }).cf?.country ?? null
