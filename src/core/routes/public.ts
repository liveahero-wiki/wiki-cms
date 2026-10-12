import { and, count, eq, gte } from 'drizzle-orm'
import { Hono } from 'hono'
import { GROUP_ID_RE, MAX_BODY_BYTES, MAX_PENDING_PER_TYPE, SUBMISSIONS_PER_IP_PER_DAY, DAY_MS, TYPE_ID_RE } from '../../config.ts'
import { getDb } from '../db/client.ts'
import { ip_block_tab, submission_tab } from '../db/schema.ts'
import { getGroup, getRoster } from '../groups.ts'
import { aiModerate } from '../ai-moderation.ts'
import { notifyNewSubmission } from '../discord-notify.ts'
import { apiError, sha256Hex, type AppEnv } from '../http.ts'
import { ipKey } from '../ip.ts'
import { blobKey, buildBlob, cfgTag, emptyBlob, pubTag } from '../publish.ts'
import { validateSubmission } from '../submission-validate.ts'
import { verifyTurnstile } from '../turnstile.ts'
import { getType } from '../types-runtime.ts'

export const publicRoutes = new Hono<AppEnv>()

const ACAO = 'Access-Control-Allow-Origin'

// ---- GET /types/:type ----
publicRoutes.get('/types/:type', async (c) => {
  const id = c.req.param('type')
  const rt = TYPE_ID_RE.test(id) ? await getType(c.env, id) : null
  if (!rt) return apiError(c, 404, 'unknown_type', 'Unknown submission type.')
  const d = rt.def
  const res = c.json({
    type: id,
    name: rt.name,
    langs: d.langs,
    tags: d.tags,
    explanation: d.explanation,
    demoUrl: d.demoUrl,
    turnstileSiteKey: c.env.TURNSTILE_SITE_KEY,
    disclaimer: d.disclaimer ?? null,
  })
  res.headers.set('Cache-Control', 'public, max-age=3600')
  res.headers.set('Cache-Tag', cfgTag(id))
  res.headers.set(ACAO, '*')
  return res
})

// ---- GET /submissions/:type/:group ----
publicRoutes.get('/submissions/:type/:group', async (c) => {
  const typeId = c.req.param('type')
  const groupId = c.req.param('group')
  const rt = TYPE_ID_RE.test(typeId) ? await getType(c.env, typeId) : null
  if (!rt) return apiError(c, 404, 'unknown_type', 'Unknown submission type.')
  if (!GROUP_ID_RE.test(groupId)) return apiError(c, 404, 'unknown_group', 'Unknown group.')

  const group = await getGroup(c.env, typeId, rt, groupId, c.get('deps').now())
  let body: string
  if (!group) {
    body = JSON.stringify(emptyBlob(typeId, rt, groupId))
  } else {
    const key = blobKey(typeId, groupId)
    let cached: string | null = null
    try {
      cached = await c.env.KV.get(key, { type: 'text', cacheTtl: 300 })
    } catch {
      /* KV unavailable: fall through to D1 */
    }
    if (cached) {
      body = cached
    } else {
      body = JSON.stringify(await buildBlob(c.env, typeId, rt, groupId, group.options))
      try {
        await c.env.KV.put(key, body, { expirationTtl: 60 * 60 * 24 * 90 })
      } catch {
        /* KV write errors/rate limits are ignorable */
      }
    }
  }

  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', [ACAO]: '*' })
  if (group) {
    headers.set('Cache-Control', 'public, max-age=300, s-maxage=86400, stale-while-revalidate=3600')
    headers.set('CDN-Cache-Control', 'public, max-age=86400')
    headers.set('Cache-Tag', pubTag(typeId, groupId))
    const etag = `"${(await sha256Hex(body)).slice(0, 24)}"`
    headers.set('ETag', etag)
    if (c.req.header('If-None-Match') === etag) return new Response(null, { status: 304, headers })
  } else {
    headers.set('Cache-Control', 'public, max-age=60')
  }
  return new Response(body, { status: 200, headers })
})

// ---- OPTIONS (CORS preflight, allowed origins only) ----
publicRoutes.options('/submissions/:type/:group', async (c) => {
  const rt = await getType(c.env, c.req.param('type'))
  const origin = c.req.header('Origin')
  if (!rt || !origin || !rt.allowedOrigins.includes(origin)) return c.body(null, 403)
  return c.body(null, 204, {
    [ACAO]: origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  })
})

// ---- POST /submissions/:type/:group ----
publicRoutes.post('/submissions/:type/:group', async (c) => {
  const typeId = c.req.param('type')
  const groupId = c.req.param('group')
  const deps = c.get('deps')
  const now = deps.now()
  const rt = TYPE_ID_RE.test(typeId) ? await getType(c.env, typeId) : null
  if (!rt) return apiError(c, 404, 'unknown_type', 'Unknown submission type.')

  // 1. Origin
  const origin = c.req.header('Origin')
  if (!origin || !rt.allowedOrigins.includes(origin)) return apiError(c, 403, 'bad_origin', 'Origin not allowed.')
  c.header(ACAO, origin)
  c.header('Vary', 'Origin')

  // 2. Body size + JSON
  const len = Number(c.req.header('Content-Length') ?? '0')
  if (len > MAX_BODY_BYTES) return apiError(c, 413, 'too_large', 'Request body too large.')
  const raw = await c.req.text()
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return apiError(c, 413, 'too_large', 'Request body too large.')
  let body: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
    body = parsed
  } catch {
    return apiError(c, 400, 'bad_json', 'Invalid JSON body.')
  }

  // 3. Honeypot
  if (typeof body.website === 'string' ? body.website !== '' : body.website !== undefined && body.website !== null) {
    return c.json({ id: crypto.randomUUID(), state: 'pending' }, 202)
  }

  // 4. IP + blocklist
  const ip = c.req.header('CF-Connecting-IP') ?? null
  const key = (ip && ipKey(ip)) || 'unknown'
  const db = getDb(c.env)
  if (await db.select({ k: ip_block_tab.ipKey }).from(ip_block_tab).where(eq(ip_block_tab.ipKey, key)).get()) {
    return apiError(c, 403, 'ip_blocked', 'Submissions from your network are currently blocked.')
  }

  // 5. Rate limit
  const rl = await c.env.SUBMIT_LIMITER.limit({ key })
  if (!rl.success) return apiError(c, 429, 'rate_limited', 'Too many submissions, please try again in a minute.')

  // 6. Group
  if (!GROUP_ID_RE.test(groupId)) return apiError(c, 404, 'unknown_group', 'Unknown group.')
  const group = await getGroup(c.env, typeId, rt, groupId, now)
  if (!group) return apiError(c, 404, 'unknown_group', 'Unknown group.')

  // 7. Validate
  const roster = await getRoster(c.env, typeId, rt, now)
  const v = validateSubmission(rt, group, body, { roster })
  if (!v.ok) return apiError(c, 400, 'validation_failed', 'Some fields are invalid.', v.errors)

  // 8. Turnstile (last of the cheap checks: tokens are single-use)
  const hostnames = rt.allowedOrigins.flatMap((o) => {
    try {
      return [new URL(o).hostname]
    } catch {
      return []
    }
  })
  const human = await verifyTurnstile({
    secret: c.env.TURNSTILE_SECRET_KEY,
    token: body.turnstileToken,
    ip,
    allowedHostnames: hostnames,
    action: 'submit',
  })
  if (!human) return apiError(c, 403, 'turnstile_failed', 'Verification failed. Please try again.')

  // 9. Caps
  const dayAgo = now - DAY_MS
  const [{ n: recent } = { n: 0 }] = await db
    .select({ n: count() })
    .from(submission_tab)
    .where(and(eq(submission_tab.ipKey, key), eq(submission_tab.type, typeId), gte(submission_tab.createdAt, dayAgo)))
  if (recent >= SUBMISSIONS_PER_IP_PER_DAY) return apiError(c, 429, 'daily_cap', 'Daily submission limit reached.')
  const [{ n: pending } = { n: 0 }] = await db
    .select({ n: count() })
    .from(submission_tab)
    .where(and(eq(submission_tab.type, typeId), eq(submission_tab.state, 'pending')))
  if (pending >= MAX_PENDING_PER_TYPE) return apiError(c, 429, 'pending_cap', 'Too many submissions are waiting for review. Please try again later.')

  // 10. Insert
  const id = crypto.randomUUID()
  const val = v.value
  await db.insert(submission_tab).values({
    id,
    type: typeId,
    groupId,
    state: 'pending',
    version: 1,
    payload: JSON.stringify(val.payload),
    tags: JSON.stringify(val.tags),
    lang: val.lang,
    explanation: val.explanation,
    explanationHtml: val.explanationHtml,
    demoUrl: val.demoUrl,
    createdAt: now,
    updatedAt: now,
    stateChangedAt: now,
    ip,
    ipKey: key,
    country: (c.req.raw as { cf?: { country?: string } }).cf?.country ?? null,
  })

  // 11. Optional AI classification (never blocks the submission).
  if (c.env.AI && c.env.AI_MODERATION !== 'off') {
    const moderationText = [val.explanation, val.demoUrl, rt.def.moderationText?.(val.payload)].filter(Boolean).join('\n')
    c.executionCtx.waitUntil(aiModerate(c.env, id, moderationText, now))
  }

  // 12. Optional Discord notification for moderators (best-effort, rate limited, never blocks).
  if (rt.discordWebhookUrl) c.executionCtx.waitUntil(notifyNewSubmission(c.env, rt, typeId, group, pending + 1, now))

  // 13.
  return c.json({ id, state: 'pending' }, 202)
})
