import { and, count, desc, eq, inArray, isNull, like, lt, max, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { AUDIT_RETENTION_DAYS, DAY_MS, GROUP_ID_RE, INVITE_TTL_MS } from '../../config.ts'
import { writeAudit } from '../audit.ts'
import { checkTypePermission, requireModerator, requireSession } from '../authz.ts'
import { getDb, type Db } from '../db/client.ts'
import {
  audit_log_tab,
  invite_tab,
  ip_block_tab,
  moderator_permission_tab,
  submission_tab,
  submission_type_tab,
  user_tab,
} from '../db/schema.ts'
import { getGroup, getRoster, listGroups } from '../groups.ts'
import { apiError, type AppEnv, type Ctx } from '../http.ts'
import { INVITE_PREFIX_LEN, hashInviteToken, newInviteToken } from '../invites.ts'
import { ipKey } from '../ip.ts'
import { republishMany } from '../publish.ts'
import { validateSubmission } from '../submission-validate.ts'
import { getType, type ResolvedType } from '../types-runtime.ts'
import { TYPE_DEFS } from '../../types/index.ts'

export const adminRoutes = new Hono<AppEnv>()

type SubmissionRow = typeof submission_tab.$inferSelect
type State = 'pending' | 'approved' | 'spam'
const STATES: State[] = ['pending', 'approved', 'spam']
const isState = (v: unknown): v is State => typeof v === 'string' && (STATES as string[]).includes(v)

function toAdminRow(r: SubmissionRow) {
  return {
    id: r.id,
    type: r.type,
    groupId: r.groupId,
    state: r.state,
    version: r.version,
    payload: JSON.parse(r.payload),
    tags: JSON.parse(r.tags),
    lang: r.lang,
    explanation: r.explanation,
    explanationHtml: r.explanationHtml,
    demoUrl: r.demoUrl,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    stateChangedAt: r.stateChangedAt,
    moderatedBy: r.moderatedBy,
    original: r.original ? JSON.parse(r.original) : null,
    ip: r.ip,
    ipKey: r.ipKey,
    country: r.country,
    aiVerdict: r.aiVerdict,
    aiReason: r.aiReason,
  }
}

async function readJson(c: Ctx): Promise<Record<string, unknown> | null> {
  try {
    const v = await c.req.json()
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Loads a type the moderator may act on; returns an error response otherwise. */
async function typeFor(c: Ctx, typeId: string): Promise<ResolvedType | Response> {
  const denied = checkTypePermission(c, typeId)
  if (denied) return denied
  const rt = await getType(c.env, typeId)
  return rt ?? apiError(c, 404, 'unknown_type', 'Unknown or disabled type.')
}

function purgeNote(res: { purgeOk: boolean }) {
  return res.purgeOk ? null : 'Published, but the cache purge failed; it will refresh within 24 h.'
}

// ---- me ----
adminRoutes.get('/me', requireSession, async (c) => {
  const db = getDb(c.env)
  const user = c.get('user')
  const perm = c.get('permTypes')
  const rows = perm.length
    ? await db.select().from(submission_type_tab).where(inArray(submission_type_tab.id, perm)).all()
    : []
  return c.json({
    user,
    types: rows.map((r) => ({
      id: r.id,
      name: r.name,
      pluginUrl: r.pluginUrl,
      enabled: !!r.enabled,
      hasCodeDef: TYPE_DEFS.some((d) => d.id === r.id),
    })),
  })
})

const mod = requireModerator

// ---- groups ----
adminRoutes.get('/types/:type/groups', mod, async (c) => {
  const typeId = c.req.param('type')
  const rt = await typeFor(c, typeId)
  if (rt instanceof Response) return rt
  const db = getDb(c.env)
  const counts = await db
    .select({ groupId: submission_tab.groupId, state: submission_tab.state, n: count(), latest: max(submission_tab.createdAt) })
    .from(submission_tab)
    .where(eq(submission_tab.type, typeId))
    .groupBy(submission_tab.groupId, submission_tab.state)
    .all()
  const registry = await listGroups(c.env, typeId, rt)
  const byId = new Map<string, { groupId: string; title: string; url: string | null; options: Record<string, unknown>; inRegistry: boolean; pending: number; approved: number; spam: number; latestAt: number | null }>()
  const ensure = (id: string) => {
    let g = byId.get(id)
    if (!g) {
      g = { groupId: id, title: id, url: null, options: {}, inRegistry: false, pending: 0, approved: 0, spam: 0, latestAt: null }
      byId.set(id, g)
    }
    return g
  }
  for (const r of counts) {
    const g = ensure(r.groupId)
    g[r.state] = r.n
    g.latestAt = Math.max(g.latestAt ?? 0, r.latest ?? 0)
  }
  const all = c.req.query('all') === '1'
  for (const g of registry) {
    if (!all && !byId.has(g.id)) continue
    const e = ensure(g.id)
    e.title = g.title
    e.url = g.url
    e.options = g.options
    e.inRegistry = true
  }
  const list = [...byId.values()].sort((a, b) => (b.latestAt ?? 0) - (a.latestAt ?? 0) || a.groupId.localeCompare(b.groupId))
  return c.json({ groups: list })
})

// ---- submissions list ----
adminRoutes.get('/types/:type/submissions', mod, async (c) => {
  const typeId = c.req.param('type')
  const rt = await typeFor(c, typeId)
  if (rt instanceof Response) return rt
  const state = c.req.query('state') ?? 'pending'
  if (!isState(state)) return apiError(c, 400, 'bad_state', 'Invalid state.')
  const group = c.req.query('group')
  const ip = c.req.query('ipKey')
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 100)
  const conds = [eq(submission_tab.type, typeId), eq(submission_tab.state, state)]
  if (group) conds.push(eq(submission_tab.groupId, group))
  if (ip) conds.push(eq(submission_tab.ipKey, ip))
  const cursor = c.req.query('cursor')
  if (cursor) {
    const m = cursor.match(/^(\d+):(.+)$/)
    if (!m) return apiError(c, 400, 'bad_cursor', 'Invalid cursor.')
    const ts = Number(m[1])
    conds.push(or(lt(submission_tab.createdAt, ts), and(eq(submission_tab.createdAt, ts), lt(submission_tab.id, m[2]!)))!)
  }
  const rows = await getDb(c.env)
    .select()
    .from(submission_tab)
    .where(and(...conds))
    .orderBy(desc(submission_tab.createdAt), desc(submission_tab.id))
    .limit(limit + 1)
    .all()
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return c.json({
    items: page.map(toAdminRow),
    nextCursor: rows.length > limit && last ? `${last.createdAt}:${last.id}` : null,
  })
})

async function loadSubmission(c: Ctx, id: string): Promise<SubmissionRow | Response> {
  const row = await getDb(c.env).select().from(submission_tab).where(eq(submission_tab.id, id)).get()
  if (!row) return apiError(c, 404, 'not_found', 'Submission not found.')
  const denied = checkTypePermission(c, row.type)
  return denied ?? row
}

adminRoutes.get('/submissions/:id', mod, async (c) => {
  const row = await loadSubmission(c, c.req.param('id'))
  return row instanceof Response ? row : c.json(toAdminRow(row))
})

// ---- edit ----
adminRoutes.patch('/submissions/:id', mod, async (c) => {
  const deps = c.get('deps')
  const body = await readJson(c)
  if (!body) return apiError(c, 400, 'bad_json', 'Invalid JSON body.')
  const row = await loadSubmission(c, c.req.param('id'))
  if (row instanceof Response) return row
  const rt = await typeFor(c, row.type)
  if (rt instanceof Response) return rt
  if (body.expectedVersion !== row.version) return apiError(c, 409, 'version_conflict', 'Someone else changed this submission; reload it.')

  const targetGroupId = body.groupId === undefined ? row.groupId : body.groupId
  if (typeof targetGroupId !== 'string' || !GROUP_ID_RE.test(targetGroupId)) return apiError(c, 400, 'unknown_group', 'Unknown group.')
  const group = await getGroup(c.env, row.type, rt, targetGroupId, deps.now())
  if (!group) return apiError(c, 400, 'unknown_group', 'Unknown group.')

  // Merge with stored values; the payload is ALWAYS validated against the resulting group.
  const merged = {
    payload: body.payload !== undefined ? body.payload : JSON.parse(row.payload),
    tags: body.tags !== undefined ? body.tags : JSON.parse(row.tags),
    lang: body.lang !== undefined ? body.lang : row.lang,
    explanation: body.explanation !== undefined ? body.explanation : row.explanation,
    demoUrl: body.demoUrl !== undefined ? body.demoUrl : row.demoUrl,
  }
  const roster = await getRoster(c.env, row.type, rt, deps.now())
  const v = validateSubmission(rt, group, merged, { roster })
  if (!v.ok) return apiError(c, 400, 'validation_failed', 'Some fields are invalid.', v.errors)

  const next = {
    payload: JSON.stringify(v.value.payload),
    tags: JSON.stringify(v.value.tags),
    lang: v.value.lang,
    explanation: v.value.explanation,
    demoUrl: v.value.demoUrl,
    groupId: targetGroupId,
  }
  const before = { payload: row.payload, tags: row.tags, lang: row.lang, explanation: row.explanation, demoUrl: row.demoUrl, groupId: row.groupId }
  const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => next[k] !== before[k])
  if (changed.length === 0) return c.json({ item: toAdminRow(row), purgeWarning: null })

  const now = deps.now()
  const db = getDb(c.env)
  const original = row.original ?? JSON.stringify({ ...before, payload: JSON.parse(before.payload), tags: JSON.parse(before.tags) })
  const res = await db
    .update(submission_tab)
    .set({
      ...next,
      explanationHtml: v.value.explanationHtml,
      original,
      version: row.version + 1,
      updatedAt: now,
      moderatedBy: c.get('user').id,
    })
    .where(and(eq(submission_tab.id, row.id), eq(submission_tab.version, row.version)))
    .run()
  if (!res.meta.changes) return apiError(c, 409, 'version_conflict', 'Someone else changed this submission; reload it.')

  await writeAudit(
    db,
    {
      actor: c.get('user').id,
      action: 'submission.edit',
      type: row.type,
      target: row.id,
      detail: {
        changed,
        before: Object.fromEntries(changed.map((k) => [k, before[k]])),
        after: Object.fromEntries(changed.map((k) => [k, next[k]])),
      },
    },
    now,
  )

  let purgeWarning: string | null = null
  if (row.state === 'approved') {
    const groups = [targetGroupId, ...(changed.includes('groupId') ? [row.groupId] : [])]
    purgeWarning = purgeNote(await republishMany(c.env, row.type, rt, groups, deps.purge))
  }
  const fresh = await db.select().from(submission_tab).where(eq(submission_tab.id, row.id)).get()
  return c.json({ item: toAdminRow(fresh!), purgeWarning })
})

// ---- state transitions ----
adminRoutes.post('/submissions/:id/state', mod, async (c) => {
  const deps = c.get('deps')
  const body = await readJson(c)
  if (!body || !isState(body.state)) return apiError(c, 400, 'bad_request', 'A valid state is required.')
  const row = await loadSubmission(c, c.req.param('id'))
  if (row instanceof Response) return row
  const rt = await typeFor(c, row.type)
  if (rt instanceof Response) return rt
  if (body.expectedVersion !== row.version) return apiError(c, 409, 'version_conflict', 'Someone else changed this submission; reload it.')
  if (row.state === body.state) return c.json({ item: toAdminRow(row), purgeWarning: null })

  const now = deps.now()
  const db = getDb(c.env)
  const res = await db
    .update(submission_tab)
    .set({ state: body.state, stateChangedAt: now, updatedAt: now, version: row.version + 1, moderatedBy: c.get('user').id })
    .where(and(eq(submission_tab.id, row.id), eq(submission_tab.version, row.version)))
    .run()
  if (!res.meta.changes) return apiError(c, 409, 'version_conflict', 'Someone else changed this submission; reload it.')
  await writeAudit(db, { actor: c.get('user').id, action: `submission.${body.state}`, type: row.type, target: row.id, detail: { from: row.state } }, now)

  let purgeWarning: string | null = null
  if (row.state === 'approved' || body.state === 'approved') {
    purgeWarning = purgeNote(await republishMany(c.env, row.type, rt, [row.groupId], deps.purge))
  }
  const fresh = await db.select().from(submission_tab).where(eq(submission_tab.id, row.id)).get()
  return c.json({ item: toAdminRow(fresh!), purgeWarning })
})

adminRoutes.post('/submissions/bulk-state', mod, async (c) => {
  const deps = c.get('deps')
  const body = await readJson(c)
  if (!body || !isState(body.state) || !Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 50 || !body.ids.every((i) => typeof i === 'string')) {
    return apiError(c, 400, 'bad_request', 'Provide 1-50 ids and a valid state.')
  }
  const ids = [...new Set(body.ids as string[])]
  const db = getDb(c.env)
  const rows = await db.select().from(submission_tab).where(inArray(submission_tab.id, ids)).all()
  for (const r of rows) {
    const denied = checkTypePermission(c, r.type)
    if (denied) return denied
  }
  const now = deps.now()
  const toRepublish = new Map<string, Set<string>>()
  const changedIds: string[] = []
  for (const r of rows) {
    if (r.state === body.state) continue
    await db
      .update(submission_tab)
      .set({ state: body.state, stateChangedAt: now, updatedAt: now, version: r.version + 1, moderatedBy: c.get('user').id })
      .where(eq(submission_tab.id, r.id))
      .run()
    changedIds.push(r.id)
    if (r.state === 'approved' || body.state === 'approved') {
      if (!toRepublish.has(r.type)) toRepublish.set(r.type, new Set())
      toRepublish.get(r.type)!.add(r.groupId)
    }
  }
  if (changedIds.length) {
    await writeAudit(db, { actor: c.get('user').id, action: 'submission.bulk_state', detail: { state: body.state, ids: changedIds } }, now)
  }
  let purgeWarning: string | null = null
  for (const [typeId, groups] of toRepublish) {
    const rt = await getType(c.env, typeId)
    if (rt) purgeWarning = purgeNote(await republishMany(c.env, typeId, rt, groups, deps.purge)) ?? purgeWarning
  }
  return c.json({ changed: changedIds.length, purgeWarning })
})

// ---- invites ----
const inviteStatus = (i: typeof invite_tab.$inferSelect, now: number) =>
  i.revokedAt ? 'revoked' : i.usedAt ? 'used' : i.expiresAt <= now ? 'expired' : 'active'

adminRoutes.get('/invites', mod, async (c) => {
  const db = getDb(c.env)
  const now = c.get('deps').now()
  const rows = await db.select().from(invite_tab).where(eq(invite_tab.createdBy, c.get('user').id)).orderBy(desc(invite_tab.createdAt)).all()
  const userIds = rows.flatMap((r) => (r.usedBy ? [r.usedBy] : []))
  const users = userIds.length ? await db.select({ id: user_tab.id, name: user_tab.name }).from(user_tab).where(inArray(user_tab.id, userIds)).all() : []
  const names = new Map(users.map((u) => [u.id, u.name]))
  return c.json({
    invites: rows.map((r) => ({
      id: r.tokenHash.slice(0, INVITE_PREFIX_LEN),
      types: JSON.parse(r.types) as string[],
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      status: inviteStatus(r, now),
      usedBy: r.usedBy ? (names.get(r.usedBy) ?? r.usedBy) : null,
      usedAt: r.usedAt,
    })),
  })
})

adminRoutes.post('/invites', mod, async (c) => {
  const body = await readJson(c)
  const types = body?.types
  if (!Array.isArray(types) || types.length === 0 || !types.every((t) => typeof t === 'string')) {
    return apiError(c, 400, 'bad_request', 'Provide the types to grant.')
  }
  const mine = c.get('permTypes')
  const unique = [...new Set(types as string[])]
  if (!unique.every((t) => mine.includes(t))) return apiError(c, 403, 'forbidden_type', 'You can only invite to types you moderate.')
  const now = c.get('deps').now()
  const token = newInviteToken()
  const db = getDb(c.env)
  const tokenHash = await hashInviteToken(token)
  await db.insert(invite_tab).values({ tokenHash, createdBy: c.get('user').id, types: JSON.stringify(unique), createdAt: now, expiresAt: now + INVITE_TTL_MS })
  await writeAudit(db, { actor: c.get('user').id, action: 'invite.create', target: tokenHash.slice(0, INVITE_PREFIX_LEN), detail: { types: unique } }, now)
  return c.json({ url: `${c.env.PUBLIC_URL.replace(/\/$/, '')}/invite/${token}`, expiresAt: now + INVITE_TTL_MS })
})

adminRoutes.delete('/invites/:prefix', mod, async (c) => {
  const prefix = c.req.param('prefix')
  if (!/^[0-9a-f]{8,64}$/.test(prefix)) return apiError(c, 400, 'bad_request', 'Invalid invite id.')
  const now = c.get('deps').now()
  const db = getDb(c.env)
  const res = await db
    .update(invite_tab)
    .set({ revokedAt: now })
    .where(and(like(invite_tab.tokenHash, `${prefix}%`), eq(invite_tab.createdBy, c.get('user').id), isNull(invite_tab.usedAt), isNull(invite_tab.revokedAt)))
    .run()
  if (!res.meta.changes) return apiError(c, 404, 'not_found', 'No such unused invite.')
  await writeAudit(db, { actor: c.get('user').id, action: 'invite.revoke', target: prefix.slice(0, INVITE_PREFIX_LEN) }, now)
  return c.json({ ok: true })
})

adminRoutes.post('/invites/claim', requireSession, async (c) => {
  const body = await readJson(c)
  const token = body?.token
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return apiError(c, 400, 'bad_request', 'Invalid invite token.')
  const now = c.get('deps').now()
  const db = getDb(c.env)
  const user = c.get('user')
  const tokenHash = await hashInviteToken(token)
  // Atomic single-use claim.
  const res = await db
    .update(invite_tab)
    .set({ usedBy: user.id, usedAt: now })
    .where(and(eq(invite_tab.tokenHash, tokenHash), isNull(invite_tab.usedAt), isNull(invite_tab.revokedAt), sql`${invite_tab.expiresAt} > ${now}`))
    .run()
  if (!res.meta.changes) return apiError(c, 404, 'invalid_invite', 'This invite link is invalid, expired or already used.')
  const invite = (await db.select().from(invite_tab).where(eq(invite_tab.tokenHash, tokenHash)).get())!
  let wanted = JSON.parse(invite.types) as string[]
  if (invite.createdBy) {
    // The inviter must STILL hold every type being granted.
    const inviterTypes = (await db.select({ t: moderator_permission_tab.type }).from(moderator_permission_tab).where(eq(moderator_permission_tab.userId, invite.createdBy)).all()).map((r) => r.t)
    wanted = wanted.filter((t) => inviterTypes.includes(t))
  }
  const existing = wanted.length ? (await db.select({ id: submission_type_tab.id }).from(submission_type_tab).where(inArray(submission_type_tab.id, wanted)).all()).map((r) => r.id) : []
  for (const type of existing) {
    await db.insert(moderator_permission_tab).values({ userId: user.id, type, grantedBy: invite.createdBy, createdAt: now }).onConflictDoNothing().run()
  }
  await writeAudit(db, { actor: user.id, action: 'invite.claim', target: tokenHash.slice(0, INVITE_PREFIX_LEN), detail: { granted: existing, requested: JSON.parse(invite.types) } }, now)
  return c.json({ granted: existing })
})

// ---- moderators (read-only) ----
adminRoutes.get('/moderators', mod, async (c) => {
  const mine = c.get('permTypes')
  const rows = await getDb(c.env)
    .select({ id: user_tab.id, name: user_tab.name, image: user_tab.image, type: moderator_permission_tab.type })
    .from(moderator_permission_tab)
    .innerJoin(user_tab, eq(user_tab.id, moderator_permission_tab.userId))
    .where(inArray(moderator_permission_tab.type, mine))
    .all()
  const byUser = new Map<string, { id: string; name: string; image: string | null; types: string[] }>()
  for (const r of rows) {
    const u = byUser.get(r.id) ?? { id: r.id, name: r.name, image: r.image, types: [] }
    u.types.push(r.type)
    byUser.set(r.id, u)
  }
  return c.json({ moderators: [...byUser.values()] })
})

// ---- IP blocks ----
adminRoutes.get('/ip-blocks', mod, async (c) => {
  const rows = await getDb(c.env).select().from(ip_block_tab).orderBy(desc(ip_block_tab.createdAt)).all()
  return c.json({ blocks: rows })
})

adminRoutes.post('/ip-blocks', mod, async (c) => {
  const body = await readJson(c)
  const key = typeof body?.ip === 'string' ? ipKey(body.ip) : null
  if (!key) return apiError(c, 400, 'invalid_ip', 'Not a valid IP address.')
  const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 500) : null
  const now = c.get('deps').now()
  const db = getDb(c.env)
  await db.insert(ip_block_tab).values({ ipKey: key, reason, createdBy: c.get('user').id, createdAt: now }).onConflictDoUpdate({ target: ip_block_tab.ipKey, set: { reason, createdBy: c.get('user').id, createdAt: now } })
  await writeAudit(db, { actor: c.get('user').id, action: 'ip.block', target: key, detail: { reason } }, now)
  return c.json({ ipKey: key })
})

adminRoutes.delete('/ip-blocks/:ipKey', mod, async (c) => {
  const key = c.req.param('ipKey')
  const db = getDb(c.env)
  const res = await db.delete(ip_block_tab).where(eq(ip_block_tab.ipKey, key)).run()
  if (!res.meta.changes) return apiError(c, 404, 'not_found', 'No such block.')
  await writeAudit(db, { actor: c.get('user').id, action: 'ip.unblock', target: key }, c.get('deps').now())
  return c.json({ ok: true })
})

// ---- audit ----
adminRoutes.get('/audit', mod, async (c) => {
  const db: Db = getDb(c.env)
  const now = c.get('deps').now()
  const mine = c.get('permTypes')
  const typeFilter = c.req.query('type')
  if (typeFilter && !mine.includes(typeFilter)) return apiError(c, 403, 'forbidden_type', 'You cannot moderate this type.')
  const conds = [sql`${audit_log_tab.at} >= ${now - AUDIT_RETENTION_DAYS * DAY_MS}`]
  conds.push(typeFilter ? eq(audit_log_tab.type, typeFilter) : or(inArray(audit_log_tab.type, mine), isNull(audit_log_tab.type))!)
  const cursor = Number(c.req.query('cursor') ?? '')
  if (Number.isFinite(cursor) && cursor > 0) conds.push(lt(audit_log_tab.id, cursor))
  const rows = await db
    .select({
      id: audit_log_tab.id,
      at: audit_log_tab.at,
      actor: audit_log_tab.actor,
      actorName: user_tab.name,
      action: audit_log_tab.action,
      type: audit_log_tab.type,
      target: audit_log_tab.target,
      detail: audit_log_tab.detail,
    })
    .from(audit_log_tab)
    .leftJoin(user_tab, eq(user_tab.id, audit_log_tab.actor))
    .where(and(...conds))
    .orderBy(desc(audit_log_tab.id))
    .limit(101)
    .all()
  const page = rows.slice(0, 100)
  return c.json({
    entries: page.map((r) => ({ ...r, actorName: r.actorName ?? r.actor, detail: r.detail ? JSON.parse(r.detail) : null })),
    nextCursor: rows.length > 100 ? page[page.length - 1]!.id : null,
  })
})

