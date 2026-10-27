import { and, desc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { CONTRIB_MIN_ACCOUNT_AGE_DAYS, DAY_MS, DEFAULT_DISPLAY_NAME, GROUP_ID_RE, MAX_PENDING_PER_TYPE, SUBMISSIONS_PER_IP_PER_DAY, SUBMISSIONS_PER_USER_PER_DAY, TYPE_ID_RE } from '../../config.ts'
import type { ContribAuthMessage, ContribSubmission, ContribRevision } from '../../shared/api-types.ts'
import { CONTRIB_SIGNIN_CALLBACK_PATH, CONTRIB_SIGNIN_HASH, CONTRIB_SIGNIN_ID_RE } from '../../shared/contrib.ts'
import { aiModerate } from '../ai-moderation.ts'
import { writeAudit } from '../audit.ts'
import { getAuth } from '../auth.ts'
import { allowedContribOrigins, contribCors, mintContribToken, normalizeDisplayName, requireContributor } from '../contrib-auth.ts'
import { getDb } from '../db/client.ts'
import { account_tab, contrib_token_tab, contributor_tab, invite_tab, moderator_permission_tab, submission_revision_tab, submission_tab, user_tab } from '../db/schema.ts'
import { notifyNewSubmission } from '../discord-notify.ts'
import { outcomeOf } from '../external.ts'
import { getGroup, getRoster } from '../groups.ts'
import { apiError, type AppEnv, type Ctx } from '../http.ts'
import { getProvider, PROVIDERS } from '../providers.ts'
import { checkClient, checkHuman, countIpRecent, countPending, countUserRecent, countryOf, isHoneypot, moderationInput, readBody } from '../submit-guards.ts'
import { validateSubmission } from '../submission-validate.ts'
import { getType, type ResolvedType } from '../types-runtime.ts'

export const contribRoutes = new Hono<AppEnv>()

const guard = [contribCors, requireContributor] as const

// =====================================================================================
// Sign-in popup (cookie session on the wiki-cms origin; Worker-rendered HTML)
// =====================================================================================

function nonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/[^A-Za-z0-9]/g, '')
}

/** JSON safe to embed in an HTML <script> block. */
const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

function htmlPage(c: Ctx, status: 200 | 400, title: string, message: string, script: string, data: unknown) {
  const n = nonce()
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style nonce="${n}">body{font:16px system-ui,sans-serif;margin:3rem auto;max-width:28rem;padding:0 1rem;color:#222}@media(prefers-color-scheme:dark){body{background:#1b1b1f;color:#ddd}}</style></head>
<body><p id="m">${message}</p><script type="application/json" id="d">${safeJson(data)}</script><script nonce="${n}">${script}</script></body></html>`
  return c.html(body, status, {
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${n}'; style-src 'nonce-${n}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'Referrer-Policy': 'no-referrer',
  })
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)

/** Where a sign-in result goes: the wiki tab's origin, plus its attempt id when the result returns by redirect (see `popupResult`). */
interface Flow {
  origin: string
  r: string | null
}

/** Starts the provider sign-in inside the popup. */
contribRoutes.get('/auth/start', async (c) => {
  const provider = getProvider(c.req.query('provider') ?? 'discord')
  const origin = c.req.query('o') ?? ''
  if (!provider || !provider.configured(c.env)) return htmlPage(c, 400, 'Sign in', 'This sign-in method is not available.', '', {})
  if (!(await allowedContribOrigins(c.env)).has(origin)) return htmlPage(c, 400, 'Sign in', 'Unknown site.', '', {})
  // Only providers that sever the opener return by redirect; for the others a stray `r` is dropped (postMessage only).
  const r = c.req.query('r')
  const flowR = provider.seversOpener && r && CONTRIB_SIGNIN_ID_RE.test(r) ? r : null
  const callbackURL = `/api/contrib/auth/done?o=${encodeURIComponent(origin)}${flowR ? `&r=${flowR}` : ''}`
  const script = `var d=JSON.parse(document.getElementById('d').textContent);
fetch('/api/auth/sign-in/social',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:d.provider,callbackURL:d.callbackURL})})
.then(function(r){return r.json()}).then(function(j){if(j&&j.url){location.href=j.url}else{throw new Error('no url')}})
.catch(function(){document.getElementById('m').textContent='Could not start sign-in. Close this window and try again.'})`
  return htmlPage(c, 200, 'Sign in', `Redirecting to ${escapeHtml(provider.label)}…`, script, { provider: provider.id, callbackURL })
})

type UserAccount = { providerId: string; accountId: string }

const userAccounts = (c: Ctx, userId: string): Promise<UserAccount[]> =>
  getDb(c.env).select({ providerId: account_tab.providerId, accountId: account_tab.accountId }).from(account_tab).where(eq(account_tab.userId, userId)).all()

/**
 * Returns whether the user's provider account is old enough. Checked only when a user first becomes a contributor,
 * so existing contributors and moderators are never re-checked. Providers without an `ageGate` (Google) always pass.
 */
function accountAgeOk(accounts: UserAccount[], now: number): { ok: true } | { ok: false; eligibleAt: number | null } {
  let earliest: number | null = null
  for (const a of accounts) {
    const provider = getProvider(a.providerId)
    if (provider && !provider.ageGate) return { ok: true }
    const created = provider?.accountCreatedAt(a.accountId) ?? null
    if (created === null) continue
    const eligibleAt = created + CONTRIB_MIN_ACCOUNT_AGE_DAYS * DAY_MS
    if (now >= eligibleAt) return { ok: true }
    earliest = earliest === null ? eligibleAt : Math.min(earliest, eligibleAt)
  }
  return { ok: false, eligibleAt: earliest }
}

const POST_SCRIPT = `var el=document.getElementById('d'),d=JSON.parse(el.textContent);el.remove();
if(window.opener&&d.origin){window.opener.postMessage(d.msg,d.origin);document.getElementById('m').textContent=d.done;setTimeout(function(){window.close()},400)}
else{document.getElementById('m').textContent=d.fallback}`

/**
 * Hands the result to the wiki tab. Normally by `postMessage` to `window.opener`. A flow with an attempt id `r` (a provider
 * whose pages sever the opener, see `ProviderDef.seversOpener`) instead redirects the popup to the wiki's callback page with
 * `#cms-signin=<JSON { r, msg }>`: the result stays in the browser that signed in, and the embed on that page passes it
 * only to the tab whose attempt id matches. Nothing is stored here, so nobody can collect someone else's result.
 */
function popupResult(c: Ctx, flow: Flow, msg: ContribAuthMessage, message: string, status: 200 | 400 = 200) {
  if (flow.r) {
    const fragment = `${CONTRIB_SIGNIN_HASH}=${encodeURIComponent(JSON.stringify({ r: flow.r, msg }))}`
    c.header('Cache-Control', 'no-store')
    c.header('Referrer-Policy', 'no-referrer')
    return c.redirect(`${flow.origin}${CONTRIB_SIGNIN_CALLBACK_PATH}#${fragment}`, 303)
  }
  const fallback = msg.type === 'cms-contrib' ? 'Signed in, but this window lost its connection to the wiki. Close it and try again from the wiki page.' : message
  return htmlPage(c, status, 'Sign in', message, POST_SCRIPT, { origin: flow.origin, msg, done: message, fallback })
}

/** OAuth callback target. Mints a bearer token and hands it to the wiki tab that opened the popup. */
contribRoutes.get('/auth/done', async (c) => {
  const r = c.req.query('r')
  const flow: Flow = { origin: c.req.query('o') ?? '', r: r && CONTRIB_SIGNIN_ID_RE.test(r) ? r : null }
  const origin = flow.origin
  if (!(await allowedContribOrigins(c.env)).has(origin)) return htmlPage(c, 400, 'Sign in', 'Unknown site.', '', {})
  const now = c.get('deps').now()
  const db = getDb(c.env)
  const session = await getAuth(c.env).api.getSession({ headers: c.req.raw.headers })
  if (!session) return popupResult(c, flow, { type: 'cms-contrib-error', code: 'unauthenticated' }, 'Sign-in did not complete. You can close this window and try again.', 400)
  const userId = session.user.id
  let accounts: UserAccount[] | undefined
  const accountsOf = async () => (accounts ??= await userAccounts(c, userId))
  // Providers that return a real name (Google) do not supply the display name: the wiki asks for one after sign-in.
  const promptsForName = async () => (await accountsOf()).some((a) => getProvider(a.providerId)?.promptDisplayName)

  let profile = await db.select().from(contributor_tab).where(eq(contributor_tab.userId, userId)).get()
  if (!profile) {
    const isModerator = !!(await db.select({ t: moderator_permission_tab.type }).from(moderator_permission_tab).where(eq(moderator_permission_tab.userId, userId)).get())
    if (!isModerator) {
      const age = accountAgeOk(await accountsOf(), now)
      if (!age.ok) {
        // Drop the account BetterAuth just created for this sign-in (nothing else references it).
        const hasInvite = !!(await db.select({ t: invite_tab.tokenHash }).from(invite_tab).where(eq(invite_tab.usedBy, userId)).get())
        const hasSubmissions = !!(await db.select({ t: submission_tab.id }).from(submission_tab).where(eq(submission_tab.userId, userId)).get())
        if (!hasInvite && !hasSubmissions) await db.delete(user_tab).where(eq(user_tab.id, userId)).run()
        const days = CONTRIB_MIN_ACCOUNT_AGE_DAYS
        const when = age.eligibleAt ? ` You can sign in again on ${new Date(age.eligibleAt).toISOString().slice(0, 10)}.` : ''
        return popupResult(c, flow, { type: 'cms-contrib-error', code: 'account_too_young', eligibleAt: age.eligibleAt }, `Your account must be at least ${days} days old to contribute.${when}`, 400)
      }
    }
    const displayName = (!(await promptsForName()) && normalizeDisplayName(session.user.name)) || DEFAULT_DISPLAY_NAME
    await db.insert(contributor_tab).values({ userId, displayName, createdAt: now }).onConflictDoNothing().run()
    await writeAudit(db, { actor: userId, action: 'contrib.create' }, now)
    profile = (await db.select().from(contributor_tab).where(eq(contributor_tab.userId, userId)).get())!
  }
  // Asked on every sign-in until a name is chosen, not only on the first: that first result may never have reached the wiki
  // (popup abandoned, another browser), and the flag otherwise lives only in the wiki tab's storage.
  const needsDisplayName = profile.displayName === DEFAULT_DISPLAY_NAME && (await promptsForName())
  const token = await mintContribToken(c.env, userId, origin, now)
  const user = { id: userId, displayName: profile.displayName, image: session.user.image ?? null }
  return popupResult(c, flow, { type: 'cms-contrib', token, user, ...(needsDisplayName ? { needsDisplayName: true as const } : {}) }, 'Signed in. You can close this window.')
})

/** The configured sign-in providers, for the embed's picker (CORS: allowed wiki origins only). */
contribRoutes.get('/auth/providers', contribCors, async (c) => c.json({ providers: PROVIDERS.filter((p) => p.configured(c.env)).map((p) => ({ id: p.id, label: p.label })) }))

// =====================================================================================
// Bearer-token API
// =====================================================================================

contribRoutes.options('*', contribCors)

contribRoutes.get('/me', ...guard, (c) => c.json({ user: c.get('contributor') }))

contribRoutes.patch('/me', ...guard, async (c) => {
  const read = await readBody(c)
  if (!read.ok) return read.res
  const name = normalizeDisplayName(read.body.displayName)
  if (!name) return apiError(c, 400, 'validation_failed', 'The display name must be 2-32 characters.', [{ path: 'displayName', code: 'display_name_invalid', message: 'The display name must be 2-32 characters.' }])
  const me = c.get('contributor')
  await getDb(c.env).update(contributor_tab).set({ displayName: name }).where(eq(contributor_tab.userId, me.id)).run()
  return c.json({ user: { ...me, displayName: name } })
})

contribRoutes.post('/auth/signout', ...guard, async (c) => {
  await getDb(c.env).delete(contrib_token_tab).where(eq(contrib_token_tab.tokenHash, c.get('contribTokenHash'))).run()
  return c.json({ ok: true })
})

type SubmissionRow = typeof submission_tab.$inferSelect
type RevisionRow = typeof submission_revision_tab.$inferSelect

function toContribRevision(r: RevisionRow): ContribRevision {
  return {
    state: r.state === 'pending' ? 'pending' : 'rejected',
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
    rejectReason: r.rejectReason,
    title: r.title,
    payload: JSON.parse(r.payload),
    tags: JSON.parse(r.tags),
    lang: r.lang as ContribRevision['lang'],
    explanation: r.explanation,
    demoUrl: r.demoUrl,
  }
}

function toContribSubmission(r: SubmissionRow, rev: RevisionRow | undefined): ContribSubmission {
  return {
    id: r.id,
    type: r.type,
    groupId: r.groupId,
    state: r.state === 'approved' ? 'approved' : 'pending', // spam is reported as "under review"
    version: r.version,
    title: r.title,
    payload: JSON.parse(r.payload),
    tags: JSON.parse(r.tags),
    lang: r.lang as ContribSubmission['lang'],
    explanation: r.explanation,
    demoUrl: r.demoUrl,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    revision: rev && (rev.state === 'pending' || rev.state === 'rejected') ? toContribRevision(rev) : null,
    outcome: outcomeOf(r.external),
  }
}

contribRoutes.get('/submissions', ...guard, async (c) => {
  const me = c.get('contributor')
  const type = c.req.query('type')
  const db = getDb(c.env)
  const rows = await db
    .select()
    .from(submission_tab)
    .where(type ? and(eq(submission_tab.userId, me.id), eq(submission_tab.type, type)) : eq(submission_tab.userId, me.id))
    .orderBy(desc(submission_tab.createdAt), desc(submission_tab.id))
    .limit(100)
    .all()
  const revs = rows.length ? await db.select().from(submission_revision_tab).where(inArray(submission_revision_tab.submissionId, rows.map((r) => r.id))).orderBy(desc(submission_revision_tab.createdAt)).all() : []
  const latest = new Map<string, RevisionRow>()
  for (const r of revs) if (!latest.has(r.submissionId)) latest.set(r.submissionId, r)
  return c.json({ items: rows.map((r) => toContribSubmission(r, latest.get(r.id))) })
})

/** Origin must be allowed for this particular type (the CORS layer only checked the union). */
function typeOriginOk(c: Ctx, allowed: string[]): boolean {
  const origin = c.req.header('Origin')
  return !!origin && allowed.includes(origin)
}

/** Optional AI classification of `version` of a row (never blocks the request). */
function moderate(c: Ctx, rt: ResolvedType, id: string, val: { title: string; explanation: string; demoUrl: string; payload: unknown }, now: number, version = 1) {
  if (!c.env.AI || c.env.AI_MODERATION === 'off') return
  const text = moderationInput(rt, val)
  if (text) c.executionCtx.waitUntil(aiModerate(c.env, id, text, now, version))
}

contribRoutes.post('/submissions/:type/:group', ...guard, async (c) => {
  const typeId = c.req.param('type')
  const groupId = c.req.param('group')
  const now = c.get('deps').now()
  const me = c.get('contributor')
  const rt = TYPE_ID_RE.test(typeId) ? await getType(c.env, typeId) : null
  if (!rt) return apiError(c, 404, 'unknown_type', 'Unknown submission type.')
  if (!typeOriginOk(c, rt.allowedOrigins)) return apiError(c, 403, 'bad_origin', 'Origin not allowed.')

  const read = await readBody(c, rt.def.maxBodyBytes)
  if (!read.ok) return read.res
  const body = read.body
  if (isHoneypot(body)) return c.json({ id: crypto.randomUUID(), state: 'pending' }, 202)
  const client = await checkClient(c)
  if (client instanceof Response) return client

  if (!GROUP_ID_RE.test(groupId)) return apiError(c, 404, 'unknown_group', 'Unknown group.')
  const group = await getGroup(c.env, typeId, rt, groupId, now)
  if (!group) return apiError(c, 404, 'unknown_group', 'Unknown group.')
  const v = validateSubmission(rt, group, body, { roster: await getRoster(c.env, typeId, rt, now) })
  if (!v.ok) return apiError(c, 400, 'validation_failed', 'Some fields are invalid.', v.errors)
  const notHuman = await checkHuman(c, rt, body, client.ip)
  if (notHuman) return notHuman

  if ((await countUserRecent(c, me.id, typeId, now)) >= SUBMISSIONS_PER_USER_PER_DAY) return apiError(c, 429, 'daily_cap', 'Daily submission limit reached.')
  if ((await countIpRecent(c, client.key, typeId, now)) >= SUBMISSIONS_PER_IP_PER_DAY) return apiError(c, 429, 'daily_cap', 'Daily submission limit reached.')
  const pending = await countPending(c, typeId)
  if (pending >= MAX_PENDING_PER_TYPE) return apiError(c, 429, 'pending_cap', 'Too many submissions are waiting for review. Please try again later.')

  const id = crypto.randomUUID()
  const val = v.value
  await getDb(c.env).insert(submission_tab).values({
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
    ip: client.ip,
    ipKey: client.key,
    country: countryOf(c),
    userId: me.id,
  })
  moderate(c, rt, id, val, now)
  if (rt.discordWebhookUrl) c.executionCtx.waitUntil(notifyNewSubmission(c.env, rt, typeId, pending + 1, now))
  return c.json({ id, state: 'pending', version: 1 }, 202)
})

/** Edit own submission. Never-published rows change in place; published rows get a pending revision (the live version stays up). */
contribRoutes.put('/submissions/:id', ...guard, async (c) => {
  const now = c.get('deps').now()
  const me = c.get('contributor')
  const db = getDb(c.env)
  const row = await db.select().from(submission_tab).where(eq(submission_tab.id, c.req.param('id'))).get()
  if (!row) return apiError(c, 404, 'not_found', 'Submission not found.')
  if (row.userId !== me.id) return apiError(c, 403, 'forbidden', 'This is not your submission.')
  const rt = await getType(c.env, row.type)
  if (!rt) return apiError(c, 404, 'unknown_type', 'Unknown submission type.')
  if (!typeOriginOk(c, rt.allowedOrigins)) return apiError(c, 403, 'bad_origin', 'Origin not allowed.')
  if (row.state === 'spam' || rt.def.editable === false) return apiError(c, 403, 'not_editable', 'This submission can no longer be edited.')

  const read = await readBody(c, rt.def.maxBodyBytes)
  if (!read.ok) return read.res
  const body = read.body
  if (isHoneypot(body)) return c.json({ id: row.id, state: 'pending', version: row.version }, 202)
  const client = await checkClient(c)
  if (client instanceof Response) return client

  if (body.expectedVersion !== row.version) return apiError(c, 409, 'version_conflict', 'This submission changed; reload it and try again.')
  const group = await getGroup(c.env, row.type, rt, row.groupId, now)
  if (!group) return apiError(c, 404, 'unknown_group', 'Unknown group.')
  const v = validateSubmission(rt, group, body, { roster: await getRoster(c.env, row.type, rt, now) })
  if (!v.ok) return apiError(c, 400, 'validation_failed', 'Some fields are invalid.', v.errors)
  const val = v.value
  const next = {
    title: val.title,
    payload: JSON.stringify(val.payload),
    tags: JSON.stringify(val.tags),
    lang: val.lang as string,
    explanation: val.explanation,
    demoUrl: val.demoUrl,
  }
  const current = { title: row.title, payload: row.payload, tags: row.tags, lang: row.lang, explanation: row.explanation, demoUrl: row.demoUrl }
  if ((Object.keys(next) as (keyof typeof next)[]).every((k) => next[k] === current[k])) return apiError(c, 400, 'no_changes', 'Nothing was changed.')

  const notHuman = await checkHuman(c, rt, body, client.ip)
  if (notHuman) return notHuman
  if ((await countUserRecent(c, me.id, row.type, now)) >= SUBMISSIONS_PER_USER_PER_DAY) return apiError(c, 429, 'daily_cap', 'Daily submission limit reached.')

  if (row.state === 'pending') {
    const res = await db
      .update(submission_tab)
      // The old AI verdict was about the old text: clear it and classify the new one.
      .set({ ...next, explanationHtml: val.explanationHtml, version: row.version + 1, updatedAt: now, aiVerdict: null, aiReason: null })
      .where(and(eq(submission_tab.id, row.id), eq(submission_tab.version, row.version)))
      .run()
    if (!res.meta.changes) return apiError(c, 409, 'version_conflict', 'This submission changed; reload it and try again.')
    moderate(c, rt, row.id, val, now, row.version + 1)
    return c.json({ id: row.id, state: 'pending', version: row.version + 1 })
  }

  // Approved: queue a revision. A new one replaces any open one.
  const hadOpen = !!(await db.select({ id: submission_revision_tab.id }).from(submission_revision_tab).where(and(eq(submission_revision_tab.submissionId, row.id), eq(submission_revision_tab.state, 'pending'))).get())
  const pending = await countPending(c, row.type)
  if (!hadOpen && pending >= MAX_PENDING_PER_TYPE) return apiError(c, 429, 'pending_cap', 'Too many submissions are waiting for review. Please try again later.')
  await db.batch([
    db.update(submission_revision_tab).set({ state: 'withdrawn', decidedAt: now }).where(and(eq(submission_revision_tab.submissionId, row.id), eq(submission_revision_tab.state, 'pending'))),
    db.insert(submission_revision_tab).values({
      id: crypto.randomUUID(),
      submissionId: row.id,
      userId: me.id,
      state: 'pending',
      baseVersion: row.version,
      ...next,
      explanationHtml: val.explanationHtml,
      createdAt: now,
    }),
  ])
  if (rt.discordWebhookUrl && !hadOpen) c.executionCtx.waitUntil(notifyNewSubmission(c.env, rt, row.type, pending + 1, now, 'revision'))
  return c.json({ id: row.id, state: 'revision_pending', version: row.version }, 202)
})

contribRoutes.delete('/submissions/:id/revision', ...guard, async (c) => {
  const me = c.get('contributor')
  const db = getDb(c.env)
  const row = await db.select({ userId: submission_tab.userId }).from(submission_tab).where(eq(submission_tab.id, c.req.param('id'))).get()
  if (!row) return apiError(c, 404, 'not_found', 'Submission not found.')
  if (row.userId !== me.id) return apiError(c, 403, 'forbidden', 'This is not your submission.')
  const res = await db
    .update(submission_revision_tab)
    .set({ state: 'withdrawn', decidedAt: c.get('deps').now() })
    .where(and(eq(submission_revision_tab.submissionId, c.req.param('id')), eq(submission_revision_tab.state, 'pending')))
    .run()
  if (!res.meta.changes) return apiError(c, 404, 'not_found', 'There is no pending edit.')
  return c.json({ ok: true })
})

