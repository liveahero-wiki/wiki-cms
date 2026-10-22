import type { Context } from 'hono'
import type { Env } from '../env.ts'
import type { AtprotoAuthFactory } from './atproto.ts'
import type { Purger } from './cache.ts'
import type { FieldError } from '../shared/plugin-api.ts'

export interface Deps {
  purge: Purger
  now: () => number
  /** Test seam: replaces the Bluesky OAuth client. */
  atproto?: AtprotoAuthFactory
}
export type AppEnv = { Bindings: Env; Variables: { deps: Deps } }
export type Ctx = Context<AppEnv>

export function apiError(c: Ctx, status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502, code: string, message: string, fields?: FieldError[]) {
  return c.json({ error: { code, message, ...(fields ? { fields } : {}) } }, status)
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Constant-ish time string comparison for secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a)
  const eb = new TextEncoder().encode(b)
  let diff = ea.length ^ eb.length
  const len = Math.max(ea.length, eb.length)
  for (let i = 0; i < len; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0)
  return diff === 0
}
