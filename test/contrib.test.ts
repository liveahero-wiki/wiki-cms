import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { CONTRIB_MIN_ACCOUNT_AGE_DAYS, SUBMISSIONS_PER_USER_PER_DAY } from '../src/config.ts'
import { runHousekeeping } from '../src/core/housekeeping.ts'
import { DAY, ORIGIN, TYPE, contribApi, contribLogin, goodTeam, makeHarness, resetState, rows, sessionCookie, snowflakeAt, submitBody, type Harness } from './helpers.ts'

let h: Harness
let clock = Date.now()
const json = async <T = any>(r: Response) => (await r.json()) as T

beforeEach(async () => {
  await resetState()
  clock = Date.now()
  h = makeHarness({ now: () => clock })
})

const setSubmitAuth = async (v: 'anonymous' | 'account') => {
  await env.DB.prepare('UPDATE submission_type_tab SET submit_auth = ? WHERE id = ?').bind(v, TYPE).run()
  const { clearTypeCache } = await import('../src/core/types-runtime.ts')
  clearTypeCache()
}

function admin(cookie: string, method: string, path: string, body?: unknown) {
  return h.fetch(`/api/admin${path}`, {
    method,
    headers: { Cookie: cookie, Origin: 'http://localhost:8787', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

let ipSeq = 0
async function create(token: string, over: Record<string, unknown> = {}, group = 'quest-1') {
  const res = await contribApi(h, token, 'POST', `/submissions/${TYPE}/${group}`, submitBody(over), { 'CF-Connecting-IP': `203.0.113.${100 + (ipSeq++ % 100)}` })
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(202)
  return (await json<{ id: string; version: number }>(res)).id
}

async function approve(id: string, version = 1) {
  const mod = await sessionCookie('mod', { types: [TYPE] })
  const res = await admin(mod, 'POST', `/submissions/${id}/state`, { expectedVersion: version, state: 'approved' })
  expect(res.status).toBe(200)
  return mod
}

const edit = (token: string, id: string, version: number, over: Record<string, unknown> = {}) =>
  contribApi(h, token, 'PUT', `/submissions/${id}`, { ...submitBody(over), expectedVersion: version }, { 'CF-Connecting-IP': `198.51.100.${1 + (ipSeq++ % 200)}` })

async function blobItems(group = 'quest-1') {
  const res = await h.fetch(`/api/v1/submissions/${TYPE}/${group}`)
  return (await json<{ items: { id: string; title: string }[] }>(res)).items
}

describe('bearer-only boundary', () => {
  it('ignores cookies on /api/contrib and bearer tokens on /api/admin', async () => {
    const token = await contribLogin('c1')
    const cookie = await sessionCookie('c1')
    expect((await contribApi(h, null, 'GET', '/me', undefined, { Cookie: cookie })).status).toBe(401)
    expect((await contribApi(h, token, 'GET', '/me')).status).toBe(200)
    const res = await h.fetch('/api/admin/me', { headers: { Authorization: `Bearer ${token}`, Origin: 'http://localhost:8787' } })
    expect(res.status).toBe(401)
  })

  it('CORS: preflight for allowed origins only, no credentials, Authorization allowed', async () => {
    const ok = await h.fetch('/api/contrib/me', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET' } })
    expect(ok.status).toBe(204)
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
    expect(ok.headers.get('Access-Control-Allow-Headers')).toContain('Authorization')
    expect(ok.headers.get('Access-Control-Allow-Credentials')).toBeNull()
    const bad = await h.fetch('/api/contrib/me', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })
    expect(bad.status).toBe(403)
    expect(bad.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect((await h.fetch('/api/contrib/me', { headers: { Authorization: 'Bearer cct_x' } })).status).toBe(403) // no Origin
  })

  it('token lifecycle: expired and signed-out tokens stop working; unknown tokens are 401', async () => {
    const expired = await contribLogin('c2', { expiresAt: Date.now() - 1000 })
    expect((await contribApi(h, expired, 'GET', '/me')).status).toBe(401)
    expect((await contribApi(h, 'cct_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'GET', '/me')).status).toBe(401)
    const token = await contribLogin('c3')
    expect((await contribApi(h, token, 'POST', '/auth/signout', {})).status).toBe(200)
    expect((await contribApi(h, token, 'GET', '/me')).status).toBe(401)
  })

  it('display name: normalised, 2-32 chars', async () => {
    const token = await contribLogin('c4')
    const ok = await contribApi(h, token, 'PATCH', '/me', { displayName: '  New   Name  ' })
    expect((await json(ok)).user.displayName).toBe('New Name')
    expect((await contribApi(h, token, 'PATCH', '/me', { displayName: 'x' })).status).toBe(400)
    expect((await contribApi(h, token, 'PATCH', '/me', { displayName: 'y'.repeat(33) })).status).toBe(400)
  })
})

describe('sign-in popup and the account-age gate', () => {
  const done = (cookie: string | null, o = ORIGIN) => h.fetch(`/api/contrib/auth/done?o=${encodeURIComponent(o)}`, { headers: cookie ? { Cookie: cookie } : {} })
  const dataOf = async (res: Response) => {
    const html = await res.text()
    return JSON.parse(html.match(/<script type="application\/json" id="d">([\s\S]*?)<\/script>/)![1]!)
  }

  it('start: renders only for configured providers and known origins', async () => {
    expect((await h.fetch(`/api/contrib/auth/start?provider=discord&o=${encodeURIComponent(ORIGIN)}`)).status).toBe(200)
    expect((await h.fetch(`/api/contrib/auth/start?provider=discord&o=${encodeURIComponent('https://evil.example')}`)).status).toBe(400)
    expect((await h.fetch(`/api/contrib/auth/start?provider=reddit&o=${encodeURIComponent(ORIGIN)}`)).status).toBe(400)
  })

  it(`rejects a Discord account younger than ${CONTRIB_MIN_ACCOUNT_AGE_DAYS} days and removes the fresh user`, async () => {
    const cookie = await sessionCookie('young', { discordId: snowflakeAt(Date.now() - 29 * DAY) })
    const res = await done(cookie)
    expect(res.status).toBe(400)
    const d = await dataOf(res)
    expect(d.msg.code).toBe('account_too_young')
    expect(d.msg.eligibleAt).toBeGreaterThan(Date.now())
    expect(d.msg.token).toBeUndefined()
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM contributor_tab').first<{ n: number }>())!.n).toBe(0)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM contrib_token_tab').first<{ n: number }>())!.n).toBe(0)
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM user_tab WHERE id='young'").first<{ n: number }>())!.n).toBe(0)
  })

  it('accepts an old enough account, mints a token and only targets the wiki origin', async () => {
    const cookie = await sessionCookie('old', { discordId: snowflakeAt(Date.now() - 31 * DAY) })
    const res = await done(cookie)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
    const html = await res.clone().text()
    expect(html).not.toContain("postMessage(d.msg,'*')")
    expect(html).toContain('postMessage(d.msg,d.origin)')
    const d = await dataOf(res)
    expect(d.origin).toBe(ORIGIN)
    expect(d.msg.type).toBe('cms-contrib')
    const me = await json(await contribApi(h, d.msg.token, 'GET', '/me'))
    expect(me.user.id).toBe('old')
  })

  it('fails closed for an unknown account age, and refuses unknown origins and missing sessions', async () => {
    const cookie = await sessionCookie('nodiscord')
    expect((await done(cookie)).status).toBe(400)
    expect((await done(await sessionCookie('x', { discordId: snowflakeAt(Date.now() - 90 * DAY) }), 'https://evil.example')).status).toBe(400)
    const res = await done(null)
    expect(res.status).toBe(400)
    expect((await dataOf(res)).msg.code).toBe('unauthenticated')
  })

  it('does not re-check existing contributors or moderators', async () => {
    const young = snowflakeAt(Date.now() - 2 * DAY)
    await contribLogin('existing')
    await env.DB.prepare('INSERT INTO account_tab (id,account_id,provider_id,user_id,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind('a1', young, 'discord', 'existing', 1, 1).run()
    expect((await done(await sessionCookie('existing'))).status).toBe(200)
    expect((await done(await sessionCookie('moddy', { types: [TYPE], discordId: young }))).status).toBe(200)
  })
})

describe('submit', () => {
  it('anonymous POST is refused for account types and still works for anonymous ones', async () => {
    const anon = () =>
      h.fetch(`/api/v1/submissions/${TYPE}/quest-1`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.9' }, body: JSON.stringify(submitBody()) })
    expect((await anon()).status).toBe(202)
    await setSubmitAuth('account')
    const res = await anon()
    expect(res.status).toBe(401)
    expect((await json(res)).error.code).toBe('account_required')
    expect((await json(await h.fetch(`/api/v1/types/${TYPE}`))).submitAuth).toBe('account')
  })

  it('creates owned submissions; keeps validation and Turnstile', async () => {
    const token = await contribLogin('u1')
    const id = await create(token)
    expect((await rows(`id='${id}'`))[0]!.user_id).toBe('u1')
    expect((await contribApi(h, null, 'POST', `/submissions/${TYPE}/quest-1`, submitBody())).status).toBe(401)
    const bad = await contribApi(h, token, 'POST', `/submissions/${TYPE}/quest-1`, submitBody({ payload: goodTeam({ heroes: [] }) }))
    expect(bad.status).toBe(400)
    await resetState({ turnstile: false })
    const t2 = await contribLogin('u1b')
    expect((await contribApi(h, t2, 'POST', `/submissions/${TYPE}/quest-1`, submitBody())).status).toBe(403)
  })

  it('caps creates + edits per contributor per day', async () => {
    const token = await contribLogin('busy')
    for (let i = 0; i < SUBMISSIONS_PER_USER_PER_DAY; i++) await create(token, { title: `Team ${i} x` })
    const res = await contribApi(h, token, 'POST', `/submissions/${TYPE}/quest-1`, submitBody({ title: 'One too many' }), { 'CF-Connecting-IP': '192.0.2.200' })
    expect(res.status).toBe(429)
    expect((await json(res)).error.code).toBe('daily_cap')
  })

  it('lists only my submissions and reports spam as pending', async () => {
    const mine = await create(await contribLogin('m1'))
    const t2 = await contribLogin('m2')
    const other = await create(t2)
    const cookie = await sessionCookie('mod', { types: [TYPE] })
    await admin(cookie, 'POST', `/submissions/${other}/state`, { expectedVersion: 1, state: 'spam' })
    const list = await json(await contribApi(h, await contribLogin('m1'), 'GET', `/submissions?type=${TYPE}`))
    expect(list.items.map((i: any) => i.id)).toEqual([mine])
    const l2 = await json(await contribApi(h, t2, 'GET', '/submissions'))
    expect(l2.items[0].state).toBe('pending')
  })
})

describe('edit', () => {
  it('edits a never-published submission in place', async () => {
    const token = await contribLogin('e1')
    const id = await create(token)
    const res = await edit(token, id, 1, { title: 'Better title' })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ id, state: 'pending', version: 2 })
    expect((await rows(`id='${id}'`))[0]!.title).toBe('Better title')
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM submission_revision_tab').first<{ n: number }>())!.n).toBe(0)
  })

  it('an in-place edit drops the AI verdict of the old text', async () => {
    const token = await contribLogin('e1b')
    const id = await create(token)
    await env.DB.prepare(`UPDATE submission_tab SET ai_verdict = 'ok', ai_reason = 'fine' WHERE id = ?`).bind(id).run()
    expect((await edit(token, id, 1, { title: 'Better title' })).status).toBe(200)
    const row = (await rows(`id='${id}'`))[0]!
    expect([row.ai_verdict, row.ai_reason]).toEqual([null, null])
  })

  it('edits a published submission through a pending revision; the live version stays up', async () => {
    const token = await contribLogin('e2')
    const id = await create(token, { title: 'Original title' })
    await approve(id)
    expect((await blobItems())[0]!.title).toBe('Original title')

    const res = await edit(token, id, 2, { title: 'Edited title' })
    expect(res.status).toBe(202)
    expect((await json(res)).state).toBe('revision_pending')
    expect((await blobItems())[0]!.title).toBe('Original title')
    const mine = await json(await contribApi(h, token, 'GET', '/submissions'))
    expect(mine.items[0].title).toBe('Original title')
    expect(mine.items[0].revision).toMatchObject({ state: 'pending', title: 'Edited title' })

    // A second edit replaces the open one.
    expect((await edit(token, id, 2, { title: 'Edited twice' })).status).toBe(202)
    const states = (await env.DB.prepare('SELECT state, title FROM submission_revision_tab ORDER BY created_at').all<{ state: string; title: string }>()).results
    expect(states.filter((s) => s.state === 'pending')).toEqual([{ state: 'pending', title: 'Edited twice' }])
    expect(states.filter((s) => s.state === 'withdrawn')).toHaveLength(1)
  })

  it('moderator approves a revision: content swaps in, blob republishes, original is kept', async () => {
    const token = await contribLogin('e3')
    const id = await create(token, { title: 'Original title' })
    const mod = await approve(id)
    await edit(token, id, 2, { title: 'Edited title' })
    const list = await json(await admin(mod, 'GET', `/types/${TYPE}/revisions?state=pending`))
    expect(list.items).toHaveLength(1)
    expect(list.items[0].owner.displayName).toBe('Contributor e3')
    expect(list.items[0].submission.title).toBe('Original title')
    h.purge.mockClear()

    const stale = await admin(mod, 'POST', `/revisions/${list.items[0].id}/approve`, { expectedVersion: 1 })
    expect(stale.status).toBe(409)
    const ok = await admin(mod, 'POST', `/revisions/${list.items[0].id}/approve`, { expectedVersion: 2 })
    expect(ok.status).toBe(200)
    expect(h.purge).toHaveBeenCalledTimes(1)
    expect((await blobItems())[0]!.title).toBe('Edited title')
    const row = (await rows(`id='${id}'`))[0]!
    expect(row.version).toBe(3)
    expect(JSON.parse(String(row.original)).title).toBe('Original title')
    expect((await json(await contribApi(h, token, 'GET', '/submissions'))).items[0].revision).toBeNull()
    // Deciding twice is refused.
    expect((await admin(mod, 'POST', `/revisions/${list.items[0].id}/approve`, { expectedVersion: 3 })).status).toBe(409)
  })

  it('rejecting keeps the live version and tells the contributor why', async () => {
    const token = await contribLogin('e4')
    const id = await create(token, { title: 'Original title' })
    const mod = await approve(id)
    await edit(token, id, 2, { title: 'Spammy title' })
    const list = await json(await admin(mod, 'GET', `/types/${TYPE}/revisions`))
    h.purge.mockClear()
    expect((await admin(mod, 'POST', `/revisions/${list.items[0].id}/reject`, { reason: 'Not accurate' })).status).toBe(200)
    expect(h.purge).not.toHaveBeenCalled()
    expect((await blobItems())[0]!.title).toBe('Original title')
    const rev = (await json(await contribApi(h, token, 'GET', '/submissions'))).items[0].revision
    expect(rev).toMatchObject({ state: 'rejected', rejectReason: 'Not accurate' })
  })

  it('withdraws a pending edit', async () => {
    const token = await contribLogin('e5')
    const id = await create(token)
    await approve(id)
    await edit(token, id, 2, { title: 'Edited title' })
    expect((await contribApi(h, token, 'DELETE', `/submissions/${id}/revision`)).status).toBe(200)
    expect((await contribApi(h, token, 'DELETE', `/submissions/${id}/revision`)).status).toBe(404)
    expect((await json(await contribApi(h, token, 'GET', '/submissions'))).items[0].revision).toBeNull()
  })

  it('guards: owner only, version conflict, spam, no-op, validation', async () => {
    const token = await contribLogin('e6')
    const other = await contribLogin('e7')
    const id = await create(token)
    expect((await edit(other, id, 1, { title: 'Hijacked title' })).status).toBe(403)
    expect((await edit(token, id, 9, { title: 'Stale version' })).status).toBe(409)
    expect(await json(await edit(token, id, 1)).then((b) => b.error.code)).toBe('no_changes')
    expect((await edit(token, id, 1, { payload: goodTeam({ heroes: [] }), title: 'Invalid team' })).status).toBe(400)
    expect((await edit(token, 'does-not-exist', 1)).status).toBe(404)
    const mod = await sessionCookie('mod', { types: [TYPE] })
    await admin(mod, 'POST', `/submissions/${id}/state`, { expectedVersion: 1, state: 'spam' })
    expect((await edit(token, id, 2, { title: 'After spam flag' })).status).toBe(403)
  })
})

describe('legacy ownership and housekeeping', () => {
  it('moderator assigns an owner to a legacy anonymous submission, audited', async () => {
    const res = await h.fetch(`/api/v1/submissions/${TYPE}/quest-1`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.9' }, body: JSON.stringify(submitBody()) })
    const id = (await json<{ id: string }>(res)).id
    const token = await contribLogin('legacy', { displayName: 'Legacy Owner' })
    expect((await edit(token, id, 1, { title: 'Not yours yet' })).status).toBe(403)

    const mod = await sessionCookie('mod', { types: [TYPE] })
    const found = await json(await admin(mod, 'GET', '/contributors?q=Legacy'))
    expect(found.contributors.map((c: any) => c.id)).toEqual(['legacy'])
    expect((await admin(mod, 'POST', `/submissions/${id}/owner`, { userId: 'ghost' })).status).toBe(404)
    const set = await json(await admin(mod, 'POST', `/submissions/${id}/owner`, { userId: 'legacy' }))
    expect(set.item.owner.displayName).toBe('Legacy Owner')
    expect((await edit(token, id, 1, { title: 'Now it is mine' })).status).toBe(200)
    const audit = await env.DB.prepare("SELECT action FROM audit_log_tab WHERE action = 'submission.set_owner'").all()
    expect(audit.results).toHaveLength(1)
  })

  it('keeps contributor accounts, drops expired tokens, prunes idle contributors', async () => {
    const t0 = Date.now()
    await contribLogin('keep', { now: t0 })
    await contribLogin('stale', { now: t0 - 200 * DAY, expiresAt: t0 - 170 * DAY })
    await contribLogin('active', { now: t0 - 200 * DAY, expiresAt: t0 + 10 * DAY })
    await env.DB.prepare('UPDATE contrib_token_tab SET last_used_at = ? WHERE user_id = ?').bind(t0 - DAY, 'active').run()
    await env.DB.prepare('UPDATE user_tab SET created_at = ? WHERE id IN (?,?,?)').bind(t0 - 300 * DAY, 'keep', 'stale', 'active').run()
    const r = await runHousekeeping(env, h.purge, t0 + 2 * DAY)
    expect(r.tokensDeleted).toBe(1)
    expect(r.contributorsPruned).toBe(1)
    const users = (await env.DB.prepare('SELECT id FROM user_tab ORDER BY id').all<{ id: string }>()).results.map((u) => u.id)
    expect(users).toEqual(['active', 'keep'])
  })
})
