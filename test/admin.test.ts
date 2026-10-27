import { PUBLISH_REV } from '../src/config.ts'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { runHousekeeping } from '../src/core/housekeeping.ts'
import { hashInviteToken, newInviteToken } from '../src/core/invites.ts'
import { ORIGIN, TYPE, goodTeam, makeHarness, resetState, submitBody, post, rows, type Harness } from './helpers.ts'

const DAY = 86_400_000
let h: Harness
let clock = 1_800_000_000_000

beforeEach(async () => {
  await resetState()
  clock = 1_800_000_000_000
  h = makeHarness({ now: () => clock })
})

// ---- helpers ----
async function hmacSigned(value: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  let bin = ''
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b)
  return encodeURIComponent(`${value}.${btoa(bin)}`)
}

/** Creates a user (+ optional permissions) and a real BetterAuth session; returns the Cookie header value. */
async function login(userId: string, types: string[] = [TYPE]): Promise<string> {
  const now = Date.now()
  await env.DB.prepare('INSERT OR IGNORE INTO user_tab (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .bind(userId, `User ${userId}`, `${userId}@users.invalid`, 0, now, now)
    .run()
  for (const t of types) {
    await env.DB.prepare('INSERT OR IGNORE INTO moderator_permission_tab (user_id,type,granted_by,created_at) VALUES (?,?,?,?)').bind(userId, t, null, now).run()
  }
  const token = `tok-${userId}-${crypto.randomUUID()}`
  await env.DB.prepare('INSERT INTO session_tab (id,expires_at,token,created_at,updated_at,user_id) VALUES (?,?,?,?,?,?)')
    .bind(crypto.randomUUID(), now + DAY, token, now, now, userId)
    .run()
  return `better-auth.session_token=${await hmacSigned(token, env.BETTER_AUTH_SECRET)}`
}

async function addType(id: string) {
  await env.DB.prepare('INSERT OR IGNORE INTO submission_type_tab (id,name,enabled,allowed_origins,plugin_url,groups_url,created_at) VALUES (?,?,?,?,?,?,?)')
    .bind(id, id, 1, '[]', 'https://x/p.js', 'https://x/g.json', 1)
    .run()
}

function api(cookie: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return h.fetch(`/api/admin${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      Origin: 'http://localhost:8787',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}
const json = async <T = any>(r: Response) => (await r.json()) as T

async function submit(group = 'quest-1', over: Record<string, unknown> = {}, ip = '203.0.113.50'): Promise<string> {
  const res = await post(h, group, submitBody(over), { 'CF-Connecting-IP': ip })
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(202)
  return (await json<{ id: string }>(res)).id
}

async function approve(cookie: string, id: string, version = 1) {
  return api(cookie, 'POST', `/submissions/${id}/state`, { expectedVersion: version, state: 'approved' })
}

// ---- tests ----
describe('authn / authz', () => {
  it('401 without session, 403 without permissions, /me works for a permission-less user', async () => {
    expect((await api(null, 'GET', '/me')).status).toBe(401)
    expect((await api(null, 'GET', `/types/${TYPE}/groups`)).status).toBe(401)
    const nobody = await login('nobody', [])
    expect((await api(nobody, 'GET', `/types/${TYPE}/groups`)).status).toBe(403)
    const me = await json(await api(nobody, 'GET', '/me'))
    expect(me.user.id).toBe('nobody')
    expect(me.types).toEqual([])
  })

  it('rejects mutations from another origin or without a JSON content type; GET is never cached', async () => {
    const mod = await login('m1')
    const bad = await api(mod, 'POST', '/ip-blocks', { ip: '1.2.3.4' }, { Origin: 'https://evil.example' })
    expect(bad.status).toBe(403)
    const noType = await h.fetch('/api/admin/ip-blocks', { method: 'POST', headers: { Cookie: mod, Origin: 'http://localhost:8787', 'Content-Type': 'text/plain' }, body: '{}' })
    expect(noType.status).toBe(400)
    const ok = await api(mod, 'GET', '/me')
    expect(ok.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('/me lists permitted types with plugin url, code-def flag and the pending counts', async () => {
    const mod = await login('m1')
    const me = await json(await api(mod, 'GET', '/me'))
    expect(me.types).toEqual([
      { id: TYPE, name: 'LAH team formation', pluginUrl: `${ORIGIN}/assets/cms/p.js`, enabled: true, hasCodeDef: true, pendingSubmissions: 0, pendingEdits: 0 },
    ])
  })

  it('/me counts pending submissions and pending contributor edits per type', async () => {
    const mod = await login('m1')
    const id = await submit()
    await submit('quest-1', {}, '203.0.113.51')
    const now = Date.now()
    await env.DB.prepare(
      `INSERT INTO submission_revision_tab (id,submission_id,user_id,state,base_version,title,payload,tags,lang,explanation,explanation_html,demo_url,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind('rev-1', id, null, 'pending', 1, 'Edited', '{}', '{}', 'en', '', '', '', now)
      .run()
    const me = await json(await api(mod, 'GET', '/me'))
    expect(me.types[0]).toMatchObject({ id: TYPE, pendingSubmissions: 2, pendingEdits: 1 })
    // A decided edit no longer counts.
    await env.DB.prepare(`UPDATE submission_revision_tab SET state = 'rejected' WHERE id = 'rev-1'`).run()
    expect((await json(await api(mod, 'GET', '/me'))).types[0]).toMatchObject({ pendingSubmissions: 2, pendingEdits: 0 })
  })

  it('moderator of type A cannot read or act on type B, nor invite for B', async () => {
    await addType('other-type')
    const now = Date.now()
    await env.DB.prepare(
      `INSERT INTO submission_tab (id,type,group_id,state,version,payload,tags,lang,explanation,explanation_html,demo_url,created_at,updated_at,state_changed_at,ip_key)
       VALUES ('b1','other-type','g','pending',1,'{}','{}','en','x','x','https://youtu.be/x',?,?,?,'1.1.1.1')`,
    ).bind(now, now, now).run()
    const a = await login('mod-a', [TYPE])
    expect((await api(a, 'GET', '/submissions/b1')).status).toBe(403)
    expect((await api(a, 'GET', '/types/other-type/submissions')).status).toBe(403)
    expect((await api(a, 'POST', '/submissions/b1/state', { expectedVersion: 1, state: 'approved' })).status).toBe(403)
    expect((await api(a, 'POST', '/submissions/bulk-state', { ids: ['b1'], state: 'spam' })).status).toBe(403)
    expect((await api(a, 'POST', '/invites', { types: ['other-type'] })).status).toBe(403)
    expect((await api(a, 'POST', '/invites', { types: [TYPE, 'other-type'] })).status).toBe(403)
    expect((await rows("id='b1'"))[0]).toMatchObject({ state: 'pending' })
  })
})

describe('moderation', () => {
  it('lists pending/approved/spam with private fields and paginates with a keyset cursor', async () => {
    const mod = await login('m1')
    for (let i = 0; i < 3; i++) {
      clock += 1000
      await submit('quest-1', { explanation: `e${i}` }, `203.0.113.${60 + i}`)
    }
    const page1 = await json(await api(mod, 'GET', `/types/${TYPE}/submissions?limit=2`))
    expect(page1.items).toHaveLength(2)
    expect(page1.nextCursor).toBeTruthy()
    expect(page1.items[0]).toHaveProperty('ip')
    expect(page1.items[0]).toHaveProperty('country')
    const page2 = await json(await api(mod, 'GET', `/types/${TYPE}/submissions?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`))
    expect(page2.items).toHaveLength(1)
    expect(page2.nextCursor).toBeNull()
    const ids = [...page1.items, ...page2.items].map((i: { id: string }) => i.id)
    expect(new Set(ids).size).toBe(3)
    expect((await json(await api(mod, 'GET', `/types/${TYPE}/submissions?state=approved`))).items).toHaveLength(0)
  })

  it('approve publishes to KV, purges the group tag, and shows up in the public list; moving back unpublishes', async () => {
    const mod = await login('m1')
    const id = await submit()
    const res = await approve(mod, id)
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.item.state).toBe('approved')
    expect(body.item.version).toBe(2)
    expect(body.purgeWarning).toBeNull()
    expect(h.purge).toHaveBeenCalledWith({ tags: [`pub:${TYPE}:quest-1`] })
    const list = await json(await h.fetch(`/api/v1/submissions/${TYPE}/quest-1`))
    expect(list.items.map((i: { id: string }) => i.id)).toEqual([id])

    h.purge.mockClear()
    const back = await api(mod, 'POST', `/submissions/${id}/state`, { expectedVersion: 2, state: 'pending' })
    expect(back.status).toBe(200)
    expect(h.purge).toHaveBeenCalledTimes(1)
    const list2 = await json(await h.fetch(`/api/v1/submissions/${TYPE}/quest-1`))
    expect(list2.items).toEqual([])
  })

  it('pending <-> spam transitions do not republish; a failed purge surfaces a warning but keeps the action', async () => {
    const mod = await login('m1')
    const id = await submit()
    const spam = await api(mod, 'POST', `/submissions/${id}/state`, { expectedVersion: 1, state: 'spam' })
    expect(spam.status).toBe(200)
    expect(h.purge).not.toHaveBeenCalled()
    h.purge.mockResolvedValueOnce({ success: false, errors: [{ code: 1, message: 'rate limited' }] })
    const ok = await api(mod, 'POST', `/submissions/${id}/state`, { expectedVersion: 2, state: 'approved' })
    expect(ok.status).toBe(200)
    expect((await json(ok)).purgeWarning).toContain('purge failed')
    expect((await rows(`id='${id}'`))[0]).toMatchObject({ state: 'approved' })
  })

  it('stale expectedVersion gives 409 for state changes and edits', async () => {
    const mod = await login('m1')
    const id = await submit()
    expect((await approve(mod, id, 1)).status).toBe(200)
    expect((await approve(mod, id, 1)).status).toBe(409)
    expect((await api(mod, 'PATCH', `/submissions/${id}`, { expectedVersion: 1, explanation: 'x' })).status).toBe(409)
  })

  it('edit stores the original once, re-renders HTML, bumps the version, republishes if approved and audits the diff', async () => {
    const mod = await login('m1')
    const id = await submit('quest-1', { explanation: 'first' })
    await approve(mod, id)
    h.purge.mockClear()
    const e1 = await api(mod, 'PATCH', `/submissions/${id}`, { expectedVersion: 2, explanation: '## Edited\nbody', tags: { teamType: 'manual', successRate: 'medium' } })
    expect(e1.status).toBe(200)
    const item = (await json(e1)).item
    expect(item.version).toBe(3)
    expect(item.explanationHtml).toContain('<h4>Edited</h4>')
    expect(item.tags).toEqual({ teamType: 'manual', successRate: 'medium' })
    expect(item.original.explanation).toBe('first')
    expect(item.original.tags).toEqual({ teamType: 'manual', successRate: 'high' })
    expect(h.purge).toHaveBeenCalledWith({ tags: [`pub:${TYPE}:quest-1`] })
    const e2 = await api(mod, 'PATCH', `/submissions/${id}`, { expectedVersion: 3, explanation: 'second edit' })
    expect((await json(e2)).item.original.explanation).toBe('first')
    const list = await json(await h.fetch(`/api/v1/submissions/${TYPE}/quest-1`))
    expect(list.items[0].tags).toEqual({ teamType: 'manual', successRate: 'medium' })
    const audit = await json(await api(mod, 'GET', '/audit'))
    const edit = audit.entries.find((a: { action: string }) => a.action === 'submission.edit')
    expect(edit.detail.changed).toEqual(expect.arrayContaining(['explanation']))
    expect(edit.actorName).toBe('User m1')
  })

  it('edit with no changes does not bump the version; validation errors return field errors', async () => {
    const mod = await login('m1')
    const id = await submit()
    const same = await api(mod, 'PATCH', `/submissions/${id}`, { expectedVersion: 1, lang: 'en' })
    expect((await json(same)).item.version).toBe(1)
    const bad = await api(mod, 'PATCH', `/submissions/${id}`, { expectedVersion: 1, demoUrl: 'https://evil.com/x' })
    expect(bad.status).toBe(400)
    expect(JSON.stringify(await json(bad))).toContain('demo_host')
  })

  it('moving to a group with a different support option revalidates the payload against the target', async () => {
    const mod = await login('m1')
    const id = await submit('quest-1') // support:false, supportIndex null
    const bad = await api(mod, 'PATCH', `/submissions/${id}`, { expectedVersion: 1, groupId: 'quest-2' }) // default support:true -> needs supportIndex
    expect(bad.status).toBe(400)
    expect(JSON.stringify(await json(bad))).toContain('support_required')
    const ok = await api(mod, 'PATCH', `/submissions/${id}`, { expectedVersion: 1, groupId: 'quest-2', payload: goodTeam({ supportIndex: 1 }) })
    expect(ok.status).toBe(200)
    expect((await json(ok)).item.groupId).toBe('quest-2')
    expect((await api(mod, 'PATCH', `/submissions/${id}`, { expectedVersion: 2, groupId: 'nope' })).status).toBe(400)
    // Moving an approved submission republishes both groups.
    await approve(mod, id, 2)
    h.purge.mockClear()
    const back = await api(mod, 'PATCH', `/submissions/${id}`, { expectedVersion: 3, groupId: 'quest-1', payload: goodTeam() })
    expect(back.status).toBe(200)
    const tags = h.purge.mock.calls.flatMap((c) => c[0].tags ?? [])
    expect(tags.sort()).toEqual([`pub:${TYPE}:quest-1`, `pub:${TYPE}:quest-2`])
  })

  it('bulk-state spams several submissions and audits once', async () => {
    const mod = await login('m1')
    const ids = [await submit('quest-1', {}, '198.51.100.7'), await submit('quest-1', { explanation: 'b' }, '198.51.100.7')]
    const res = await api(mod, 'POST', '/submissions/bulk-state', { ids, state: 'spam' })
    expect((await json(res)).changed).toBe(2)
    expect(await rows("state='spam'")).toHaveLength(2)
    expect((await api(mod, 'POST', '/submissions/bulk-state', { ids: [], state: 'spam' })).status).toBe(400)
    const filtered = await json(await api(mod, 'GET', `/types/${TYPE}/submissions?state=spam&ipKey=198.51.100.7`))
    expect(filtered.items).toHaveLength(2)
  })

  it('groups list merges counts with registry titles/options', async () => {
    const mod = await login('m1')
    const a = await submit('quest-1')
    await submit('quest-1', { explanation: 'x' }, '203.0.113.51')
    await approve(mod, a)
    const res = await json(await api(mod, 'GET', `/types/${TYPE}/groups`))
    expect(res.groups).toHaveLength(1)
    expect(res.groups[0]).toMatchObject({ groupId: 'quest-1', title: 'Event › SS', options: { support: false }, pending: 1, approved: 1, spam: 0, inRegistry: true })
    const all = await json(await api(mod, 'GET', `/types/${TYPE}/groups?all=1`))
    expect(all.groups.map((g: { groupId: string }) => g.groupId).sort()).toEqual(['all', 'hero-10251', 'quest-1', 'quest-2'])
  })
})

describe('IP blocks', () => {
  it('blocks normalized IPs, rejects invalid ones, enforces on submit, and unblocks', async () => {
    const mod = await login('m1')
    expect((await api(mod, 'POST', '/ip-blocks', { ip: 'garbage' })).status).toBe(400)
    const res = await api(mod, 'POST', '/ip-blocks', { ip: '2001:db8:1:2:aaaa::1', reason: 'spammer' })
    expect((await json(res)).ipKey).toBe('2001:db8:1:2::')
    const blocked = await post(h, 'quest-1', submitBody(), { 'CF-Connecting-IP': '2001:db8:1:2::77' })
    expect(blocked.status).toBe(403)
    expect((await api(mod, 'DELETE', '/ip-blocks/2001:db8:1:2::')).status).toBe(200)
    expect((await post(h, 'quest-1', submitBody(), { 'CF-Connecting-IP': '2001:db8:1:2::77' })).status).toBe(202)
    expect((await api(mod, 'DELETE', '/ip-blocks/2001:db8:1:2::')).status).toBe(404)
  })
})

describe('invites', () => {
  it('create -> claim grants permissions once; second claim fails; expires after 24 h; revocable', async () => {
    const inviter = await login('inviter')
    const create = await json(await api(inviter, 'POST', '/invites', { types: [TYPE] }))
    expect(create.url).toMatch(/^http:\/\/localhost:8787\/invite\/[A-Za-z0-9_-]{40,}$/)
    expect(create.expiresAt).toBe(clock + DAY)
    const token = create.url.split('/invite/')[1]

    const newbie = await login('newbie', [])
    const claim = await api(newbie, 'POST', '/invites/claim', { token })
    expect(claim.status).toBe(200)
    expect((await json(claim)).granted).toEqual([TYPE])
    expect((await json(await api(newbie, 'GET', '/me'))).types.map((t: { id: string }) => t.id)).toEqual([TYPE])
    const other = await login('other', [])
    expect((await api(other, 'POST', '/invites/claim', { token })).status).toBe(404)

    // The raw token is never stored.
    const stored = await env.DB.prepare('SELECT token_hash FROM invite_tab').all<{ token_hash: string }>()
    expect(stored.results[0]!.token_hash).toBe(await hashInviteToken(token))
    expect(JSON.stringify(stored.results)).not.toContain(token)

    // Expiry.
    const t2 = (await json(await api(inviter, 'POST', '/invites', { types: [TYPE] }))).url.split('/invite/')[1]
    clock += DAY + 1
    expect((await api(other, 'POST', '/invites/claim', { token: t2 })).status).toBe(404)

    // Revocation.
    clock += 1
    const t3 = await json(await api(inviter, 'POST', '/invites', { types: [TYPE] }))
    const list = await json(await api(inviter, 'GET', '/invites'))
    const active = list.invites.find((i: { status: string }) => i.status === 'active')
    expect((await api(inviter, 'DELETE', `/invites/${active.id}`)).status).toBe(200)
    expect((await api(other, 'POST', '/invites/claim', { token: t3.url.split('/invite/')[1] })).status).toBe(404)
    expect((await json(await api(inviter, 'GET', '/invites'))).invites.map((i: { status: string }) => i.status).sort()).toEqual(['expired', 'revoked', 'used'])
  })

  it('grants only the intersection when the inviter lost a permission; CLI invites (no inviter) grant everything that exists', async () => {
    await addType('t2')
    const inviter = await login('inviter', [TYPE, 't2'])
    const tok = (await json(await api(inviter, 'POST', '/invites', { types: [TYPE, 't2'] }))).url.split('/invite/')[1]
    await env.DB.prepare("DELETE FROM moderator_permission_tab WHERE user_id='inviter' AND type='t2'").run()
    const newbie = await login('newbie', [])
    expect((await json(await api(newbie, 'POST', '/invites/claim', { token: tok }))).granted).toEqual([TYPE])

    const cliToken = newInviteToken()
    await env.DB.prepare('INSERT INTO invite_tab (token_hash,created_by,types,created_at,expires_at) VALUES (?,?,?,?,?)')
      .bind(await hashInviteToken(cliToken), null, JSON.stringify([TYPE, 't2', 'missing-type']), clock, clock + DAY)
      .run()
    const second = await login('second', [])
    expect((await json(await api(second, 'POST', '/invites/claim', { token: cliToken }))).granted.sort()).toEqual([TYPE, 't2'])
  })

  it('claim requires a session, not permissions; rejects junk tokens', async () => {
    expect((await api(null, 'POST', '/invites/claim', { token: 'x'.repeat(43) })).status).toBe(401)
    const u = await login('u', [])
    expect((await api(u, 'POST', '/invites/claim', { token: 'short' })).status).toBe(400)
  })

  it('lists moderators sharing my types (read-only)', async () => {
    await addType('t2')
    const a = await login('a', [TYPE])
    await login('b', [TYPE, 't2'])
    await login('c', ['t2'])
    const list = (await json(await api(a, 'GET', '/moderators'))).moderators.map((m: { id: string }) => m.id).sort()
    expect(list).toEqual(['a', 'b'])
  })
})

describe('audit', () => {
  it('only shows entries for my types plus global ones, newest first, last 30 days', async () => {
    const mod = await login('m1')
    const db = env.DB
    const ins = (at: number, type: string | null, action: string) =>
      db.prepare('INSERT INTO audit_log_tab (at,actor,action,type) VALUES (?,?,?,?)').bind(at, 'cli', action, type).run()
    await ins(clock - 1000, TYPE, 'mine')
    await ins(clock - 500, null, 'global')
    await ins(clock - 400, 'other-type', 'theirs')
    await ins(clock - 31 * DAY, TYPE, 'too-old')
    const res = await json(await api(mod, 'GET', '/audit'))
    expect(res.entries.map((e: { action: string }) => e.action)).toEqual(['global', 'mine'])
    expect(res.entries[0].actorName).toBe('cli')
    expect((await api(mod, 'GET', '/audit?type=other-type')).status).toBe(403)
  })
})

describe('internal API', () => {
  const call = (token: string | null, body: unknown) =>
    h.fetch('/api/internal/republish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })

  it('requires the CLI bearer token', async () => {
    expect((await call(null, { type: TYPE })).status).toBe(401)
    expect((await call('wrong', { type: TYPE })).status).toBe(401)
    const mod = await login('m1')
    expect((await h.fetch('/api/internal/republish', { method: 'POST', headers: { Cookie: mod, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401)
  })

  it('republishes a type (all registry groups + cfg tag) or a single group, or purges everything', async () => {
    const mod = await login('m1')
    const id = await submit()
    await approve(mod, id)
    h.purge.mockClear()
    const res = await json(await call('test-cli-token', { type: TYPE }))
    expect(res.purgeOk).toBe(true)
    const tags = h.purge.mock.calls.flatMap((c) => c[0].tags ?? []).sort()
    expect(tags).toEqual([`cfg:${TYPE}`, `pub:${TYPE}:all`, `pub:${TYPE}:hero-10251`, `pub:${TYPE}:quest-1`, `pub:${TYPE}:quest-2`])
    h.purge.mockClear()
    await call('test-cli-token', { type: TYPE, group: 'quest-1' })
    expect(h.purge.mock.calls).toEqual([[{ tags: [`pub:${TYPE}:quest-1`] }]])
    h.purge.mockClear()
    await call('test-cli-token', { all: true })
    expect(h.purge).toHaveBeenCalledWith({ purgeEverything: true })
    expect((await call('test-cli-token', { type: 'nope' })).status).toBe(404)
  })
})

describe('housekeeping', () => {
  const insertSub = (id: string, state: string, stateChangedAt: number, createdAt: number, ip: string | null = '1.1.1.1') =>
    env.DB.prepare(
      `INSERT INTO submission_tab (id,type,group_id,state,version,payload,tags,lang,explanation,explanation_html,demo_url,created_at,updated_at,state_changed_at,ip,ip_key)
       VALUES (?,?,?,?,1,'{}','{}','en','x','x','https://youtu.be/x',?,?,?,?,'1.1.1.1')`,
    ).bind(id, TYPE, 'quest-1', state, createdAt, createdAt, stateChangedAt, ip).run()

  it('deletes spam after 14 days (clock resets when state changes), old audit rows, old invites, expired sessions, orphan users, and nulls old IPs', async () => {
    const now = clock
    await insertSub('spam-old', 'spam', now - 15 * DAY, now - 20 * DAY)
    await insertSub('spam-new', 'spam', now - 13 * DAY, now - 20 * DAY)
    await insertSub('pending-old', 'pending', now - 100 * DAY, now - 100 * DAY)
    await insertSub('approved-old', 'approved', now - 100 * DAY, now - 100 * DAY)
    await insertSub('fresh', 'pending', now, now)
    await env.DB.prepare('INSERT INTO audit_log_tab (at,actor,action) VALUES (?,?,?)').bind(now - 31 * DAY, 'cli', 'old').run()
    await env.DB.prepare('INSERT INTO audit_log_tab (at,actor,action) VALUES (?,?,?)').bind(now - 1 * DAY, 'cli', 'recent').run()
    await env.DB.prepare('INSERT INTO invite_tab (token_hash,types,created_at,expires_at) VALUES (?,?,?,?)').bind('old', '[]', now - 9 * DAY, now - 8 * DAY).run()
    await env.DB.prepare('INSERT INTO invite_tab (token_hash,types,created_at,expires_at) VALUES (?,?,?,?)').bind('recent', '[]', now - 3 * DAY, now - 2 * DAY).run()
    // Orphan user (old, no permissions) vs moderator vs fresh signup.
    const mk = (id: string, createdAt: number) =>
      env.DB.prepare('INSERT INTO user_tab (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,?,?)').bind(id, id, `${id}@x.invalid`, createdAt, createdAt).run()
    await mk('orphan', now - 2 * DAY)
    await mk('mod', now - 2 * DAY)
    await mk('fresh-user', now - 1000)
    await env.DB.prepare('INSERT INTO moderator_permission_tab (user_id,type,created_at) VALUES (?,?,?)').bind('mod', TYPE, now).run()
    await env.DB.prepare('INSERT INTO session_tab (id,expires_at,token,created_at,updated_at,user_id) VALUES (?,?,?,?,?,?)').bind('s-exp', now - 1000, 't1', 1, 1, 'mod').run()
    await env.DB.prepare('INSERT INTO session_tab (id,expires_at,token,created_at,updated_at,user_id) VALUES (?,?,?,?,?,?)').bind('s-ok', now + DAY, 't2', 1, 1, 'mod').run()

    const r = await runHousekeeping(env, h.purge, now)
    expect(r).toMatchObject({ spamDeleted: 1, auditDeleted: 1, invitesDeleted: 1, sessionsDeleted: 1, usersDeleted: 1, ipsCleared: 2 })
    const ids = (await rows()).map((x) => x.id)
    expect(ids.sort()).toEqual(['approved-old', 'fresh', 'pending-old', 'spam-new'])
    const old = (await rows("id='pending-old'"))[0]!
    expect(old.ip).toBeNull()
    expect(old.ip_key).toBe('1.1.1.1')
    expect((await rows("id='fresh'"))[0]!.ip).toBe('1.1.1.1')
    const users = (await env.DB.prepare('SELECT id FROM user_tab').all<{ id: string }>()).results.map((u) => u.id).sort()
    expect(users).toEqual(['fresh-user', 'mod'])
    const audit = (await env.DB.prepare('SELECT action FROM audit_log_tab ORDER BY id').all<{ action: string }>()).results.map((a) => a.action)
    expect(audit).toEqual(['recent', 'system.housekeeping'])
  })

  it('writes no audit row when nothing was deleted, and republishes groups whose options changed', async () => {
    const mod = await login('m1')
    const id = await submit('quest-2', { payload: goodTeam({ supportIndex: 1 }) })
    await approve(mod, id)
    await runHousekeeping(env, h.purge, Date.now()) // first fetch caches the registry
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM audit_log_tab WHERE action='system.housekeeping'").first<{ n: number }>())!.n).toBe(0)

    // Flip quest-2's support option in the registry.
    const changed = { groups: { ...(await (await fetch('https://wiki.test/api/cms-groups.json')).json() as any).groups } }
    changed.groups['quest-2'] = { ...changed.groups['quest-2'], options: { support: false } }
    ;(globalThis.fetch as unknown as { mockImplementation: (f: unknown) => void }).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      return url === 'https://wiki.test/api/cms-groups.json' ? new Response(JSON.stringify(changed)) : new Response('nf', { status: 404 })
    })
    h.purge.mockClear()
    const r = await runHousekeeping(env, h.purge, clock + 1000)
    expect(r.groupsRepublished).toBe(1)
    expect(h.purge).toHaveBeenCalledWith({ tags: [`pub:${TYPE}:quest-2`] })
    const blob = JSON.parse((await env.KV.get(`pub:${PUBLISH_REV}:${TYPE}:quest-2`))!)
    expect(blob.groupOptions).toEqual({ support: false })
  })
})
