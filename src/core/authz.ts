import { eq } from 'drizzle-orm'
import type { MiddlewareHandler } from 'hono'
import { getAuth } from './auth.ts'
import { getDb } from './db/client.ts'
import { moderator_permission_tab } from './db/schema.ts'
import { apiError, type AppEnv, type Ctx } from './http.ts'

export interface SessionUser {
  id: string
  name: string
  image: string | null
}

declare module 'hono' {
  interface ContextVariableMap {
    user: SessionUser
    permTypes: string[]
  }
}

/** CSRF guard for mutations: JSON content type + same-origin `Origin`. Returns an error response or null. */
function csrfCheck(c: Ctx): Response | null {
  const m = c.req.method
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return null
  const origin = c.req.header('Origin')
  let expected = ''
  try {
    expected = new URL(c.env.PUBLIC_URL).origin
  } catch {
    /* misconfigured PUBLIC_URL: reject below */
  }
  if (!origin || origin !== expected) return apiError(c, 403, 'bad_origin', 'Origin not allowed.')
  // DELETE requests carry no body; everything else must be JSON.
  if (m !== 'DELETE' && !(c.req.header('Content-Type') ?? '').toLowerCase().startsWith('application/json')) {
    return apiError(c, 400, 'bad_content_type', 'Content-Type must be application/json.')
  }
  return null
}

/** Loads the session into the context. Returns an error response or null. */
async function loadSession(c: Ctx): Promise<Response | null> {
  const bad = csrfCheck(c)
  if (bad) return bad
  const session = await getAuth(c.env).api.getSession({ headers: c.req.raw.headers })
  if (!session) return apiError(c, 401, 'unauthenticated', 'Sign in required.')
  c.set('user', { id: session.user.id, name: session.user.name, image: session.user.image ?? null })
  const rows = await getDb(c.env)
    .select({ type: moderator_permission_tab.type })
    .from(moderator_permission_tab)
    .where(eq(moderator_permission_tab.userId, session.user.id))
    .all()
  c.set('permTypes', rows.map((r) => r.type))
  return null
}

/** Requires a valid session; sets `user` and `permTypes`. Does NOT require permissions. */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const bad = await loadSession(c)
  if (bad) return bad
  await next()
}

/** Requires a session AND at least one permission. */
export const requireModerator: MiddlewareHandler<AppEnv> = async (c, next) => {
  const bad = await loadSession(c)
  if (bad) return bad
  if (c.get('permTypes').length === 0) return apiError(c, 403, 'no_permissions', 'Your account has no moderator permissions.')
  await next()
}

/** Returns an error response unless the current user may moderate `type`. */
export function checkTypePermission(c: Ctx, type: string): Response | null {
  return c.get('permTypes').includes(type) ? null : apiError(c, 403, 'forbidden_type', 'You cannot moderate this type.')
}
