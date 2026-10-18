import { Hono } from 'hono'
import { GROUP_ID_RE, MAX_PENDING_PER_TYPE, SUBMISSIONS_PER_IP_PER_DAY, TYPE_ID_RE } from '../../config.ts'
import { getDb } from '../db/client.ts'
import { submission_tab } from '../db/schema.ts'
import { getGroup, getRoster } from '../groups.ts'
import { aiModerate } from '../ai-moderation.ts'
import { notifyNewSubmission } from '../discord-notify.ts'
import { apiError, sha256Hex, type AppEnv } from '../http.ts'
import { blobKey, buildBlob, cfgTag, emptyBlob, pubTag } from '../publish.ts'
import { checkClient, checkHuman, countIpRecent, countPending, countryOf, isHoneypot, readBody } from '../submit-guards.ts'
import { validateSubmission } from '../submission-validate.ts'
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
    title: d.title ?? null,
    explanation: d.explanation,
    demoUrl: d.demoUrl,
    turnstileSiteKey: c.env.TURNSTILE_SITE_KEY,
    disclaimer: d.disclaimer ?? null,
    submitAuth: rt.submitAuth,
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

  // 1b. Types that require a contributor account refuse anonymous submissions (the CORS headers above let the embed read this).
  if (rt.submitAuth === 'account') return apiError(c, 401, 'account_required', 'Sign in with a contributor account to submit.')

  // 2. Body size + JSON
  const read = await readBody(c)
  if (!read.ok) return read.res
  const body = read.body

  // 3. Honeypot
  if (isHoneypot(body)) return c.json({ id: crypto.randomUUID(), state: 'pending' }, 202)

  // 4 + 5. IP blocklist + rate limit
  const client = await checkClient(c)
  if (client instanceof Response) return client
  const { ip, key } = client
  const db = getDb(c.env)

  // 6. Group
  if (!GROUP_ID_RE.test(groupId)) return apiError(c, 404, 'unknown_group', 'Unknown group.')
  const group = await getGroup(c.env, typeId, rt, groupId, now)
  if (!group) return apiError(c, 404, 'unknown_group', 'Unknown group.')

  // 7. Validate
  const roster = await getRoster(c.env, typeId, rt, now)
  const v = validateSubmission(rt, group, body, { roster })
  if (!v.ok) return apiError(c, 400, 'validation_failed', 'Some fields are invalid.', v.errors)

  // 8. Turnstile (last of the cheap checks: tokens are single-use)
  const notHuman = await checkHuman(c, rt, body, ip)
  if (notHuman) return notHuman

  // 9. Caps
  if ((await countIpRecent(c, key, typeId, now)) >= SUBMISSIONS_PER_IP_PER_DAY) return apiError(c, 429, 'daily_cap', 'Daily submission limit reached.')
  const pending = await countPending(c, typeId)
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
    title: val.title,
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
    country: countryOf(c),
  })

  // 11. Optional AI classification (never blocks the submission).
  if (c.env.AI && c.env.AI_MODERATION !== 'off') {
    const moderationText = [val.title, val.explanation, val.demoUrl, rt.def.moderationText?.(val.payload)].filter(Boolean).join('\n')
    c.executionCtx.waitUntil(aiModerate(c.env, id, moderationText, now))
  }

  // 12. Optional Discord notification for moderators (best-effort, rate limited, never blocks).
  if (rt.discordWebhookUrl) c.executionCtx.waitUntil(notifyNewSubmission(c.env, rt, typeId, group, pending + 1, now))

  // 13.
  return c.json({ id, state: 'pending' }, 202)
})
