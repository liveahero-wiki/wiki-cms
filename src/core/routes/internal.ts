import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { GROUP_ID_RE, TYPE_ID_RE } from '../../config.ts'
import { writeAudit } from '../audit.ts'
import { getDb } from '../db/client.ts'
import { contributor_tab, submission_tab } from '../db/schema.ts'
import { encodeExternal } from '../external.ts'
import { listGroups, refreshGroups, refreshRoster } from '../groups.ts'
import { apiError, safeEqual, type AppEnv } from '../http.ts'
import { cfgTag, republishMany } from '../publish.ts'
import { getType, clearTypeCache } from '../types-runtime.ts'

export const internalRoutes = new Hono<AppEnv>()

// Bearer CLI_TOKEN. Never callable with a session.
internalRoutes.use('*', async (c, next) => {
  const auth = c.req.header('Authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!c.env.CLI_TOKEN || !token || !safeEqual(token, c.env.CLI_TOKEN)) return apiError(c, 401, 'unauthenticated', 'Invalid token.')
  await next()
})

internalRoutes.post('/republish', async (c) => {
  const deps = c.get('deps')
  let body: { type?: unknown; group?: unknown; all?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return apiError(c, 400, 'bad_json', 'Invalid JSON body.')
  }
  if (body.all === true) {
    const res = await deps.purge({ purgeEverything: true })
    return c.json({ purged: 'everything', success: res.success, errors: res.errors })
  }
  const typeId = typeof body.type === 'string' ? body.type : ''
  clearTypeCache()
  const rt = TYPE_ID_RE.test(typeId) ? await getType(c.env, typeId) : null
  if (!rt) return apiError(c, 404, 'unknown_type', 'Unknown or disabled type.')

  let groups: string[]
  if (body.group !== undefined) {
    if (typeof body.group !== 'string' || !GROUP_ID_RE.test(body.group)) return apiError(c, 400, 'bad_request', 'Invalid group.')
    groups = [body.group]
  } else {
    // Fresh registry + roster, then every registry group plus any group that still has approved rows.
    await refreshGroups(c.env, typeId, rt, deps.now())
    await refreshRoster(c.env, typeId, rt, deps.now())
    const reg = (await listGroups(c.env, typeId, rt, deps.now())).map((g) => g.id)
    const db = getDb(c.env)
    const withRows = await db
      .selectDistinct({ g: submission_tab.groupId })
      .from(submission_tab)
      .where(eq(submission_tab.type, typeId))
      .all()
    groups = [...new Set([...reg, ...withRows.map((r) => r.g)])]
  }
  const result = await republishMany(c.env, typeId, rt, groups, deps.purge)
  let cfgOk = true
  if (body.group === undefined) {
    try {
      cfgOk = (await deps.purge({ tags: [cfgTag(typeId)] })).success
    } catch {
      cfgOk = false
    }
  }
  await writeAudit(getDb(c.env), { actor: 'cli', action: 'cli.republish', type: typeId, detail: { groups: groups.length, purgeOk: result.purgeOk && cfgOk } }, deps.now())
  return c.json({ republished: groups.length, purgeOk: result.purgeOk && cfgOk, errors: result.errors })
})

// ---- Work done outside the Worker (the intake Action, a type's own jobs) ----

const EXTERNAL_BATCH = 100

/**
 * Approved submissions nobody has acted on yet (`external` is null), oldest first: what the translation intake Action pulls.
 * Includes the owner's display name for attribution. Never exposes IPs.
 */
internalRoutes.get('/submissions/:type', async (c) => {
  const typeId = c.req.param('type')
  clearTypeCache()
  const rt = TYPE_ID_RE.test(typeId) ? await getType(c.env, typeId) : null
  if (!rt) return apiError(c, 404, 'unknown_type', 'Unknown or disabled type.')
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? EXTERNAL_BATCH) || EXTERNAL_BATCH, 1), 500)
  const db = getDb(c.env)
  const rows = await db
    .select({
      id: submission_tab.id,
      version: submission_tab.version,
      groupId: submission_tab.groupId,
      lang: submission_tab.lang,
      payload: submission_tab.payload,
      userId: submission_tab.userId,
      stateChangedAt: submission_tab.stateChangedAt,
    })
    .from(submission_tab)
    .where(and(eq(submission_tab.type, typeId), eq(submission_tab.state, 'approved'), isNull(submission_tab.external)))
    .orderBy(asc(submission_tab.stateChangedAt), asc(submission_tab.id))
    .limit(limit)
    .all()
  const ids = [...new Set(rows.flatMap((r) => (r.userId ? [r.userId] : [])))]
  const names = new Map(
    ids.length ? (await db.select({ id: contributor_tab.userId, displayName: contributor_tab.displayName }).from(contributor_tab).where(inArray(contributor_tab.userId, ids)).all()).map((r) => [r.id, r.displayName] as const) : [],
  )
  return c.json({
    items: rows.map((r) => ({
      id: r.id,
      version: r.version,
      groupId: r.groupId,
      lang: r.lang,
      payload: JSON.parse(r.payload),
      approvedAt: r.stateChangedAt,
      displayName: r.userId ? (names.get(r.userId) ?? null) : null,
    })),
  })
})

/**
 * Records what the Action did with approved submissions: `{ results: [{ id, external }] }`. `external` is a JSON object
 * (see src/core/external.ts; `outcome.status` such as "synced" or "conflict" is what the owner sees). A row that already has an
 * `external` is left alone, so a repeated run cannot overwrite a moderator's decision.
 */
internalRoutes.post('/submissions/:type/external', async (c) => {
  const typeId = c.req.param('type')
  clearTypeCache()
  const rt = TYPE_ID_RE.test(typeId) ? await getType(c.env, typeId) : null
  if (!rt) return apiError(c, 404, 'unknown_type', 'Unknown or disabled type.')
  let body: { results?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return apiError(c, 400, 'bad_json', 'Invalid JSON body.')
  }
  if (!Array.isArray(body.results) || body.results.length === 0 || body.results.length > EXTERNAL_BATCH) return apiError(c, 400, 'bad_request', `Provide 1-${EXTERNAL_BATCH} results.`)
  const now = c.get('deps').now()
  const db = getDb(c.env)
  const stored: string[] = []
  const skipped: string[] = []
  for (const r of body.results as { id?: unknown; external?: unknown }[]) {
    if (typeof r?.id !== 'string') return apiError(c, 400, 'bad_request', 'Every result needs an id.')
    const enc = encodeExternal(r.external)
    if (!enc.ok) return apiError(c, 400, 'bad_request', `${r.id}: ${enc.message}`)
    const res = await db
      .update(submission_tab)
      .set({ external: enc.json, externalAt: now })
      .where(and(eq(submission_tab.id, r.id), eq(submission_tab.type, typeId), eq(submission_tab.state, 'approved'), isNull(submission_tab.external)))
      .run()
    ;(res.meta.changes ? stored : skipped).push(r.id)
  }
  if (stored.length) await writeAudit(db, { actor: 'cli', action: 'cli.external', type: typeId, detail: { stored: stored.length, ids: stored } }, now)
  return c.json({ stored, skipped })
})
