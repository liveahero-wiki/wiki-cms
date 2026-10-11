import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { GROUP_ID_RE, TYPE_ID_RE } from '../../config.ts'
import { writeAudit } from '../audit.ts'
import { getDb } from '../db/client.ts'
import { submission_tab } from '../db/schema.ts'
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
