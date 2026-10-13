import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { PUBLISH_REV } from '../src/config.ts'
import { runHousekeeping } from '../src/core/housekeeping.ts'
import { REGISTRY, TYPE, goodTeam, makeHarness, post, resetState, rows, submitBody, type Harness } from './helpers.ts'

const DAY = 86_400_000
let h: Harness
beforeEach(async () => {
  await resetState()
  h = makeHarness()
})

async function hmacSigned(value: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  let bin = ''
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b)
  return encodeURIComponent(`${value}.${btoa(bin)}`)
}
async function login(): Promise<string> {
  const now = Date.now()
  await env.DB.prepare('INSERT INTO user_tab (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind('m1', 'M1', 'm1@users.invalid', 0, now, now).run()
  await env.DB.prepare('INSERT INTO moderator_permission_tab (user_id,type,granted_by,created_at) VALUES (?,?,?,?)').bind('m1', TYPE, null, now).run()
  const token = `tok-${crypto.randomUUID()}`
  await env.DB.prepare('INSERT INTO session_tab (id,expires_at,token,created_at,updated_at,user_id) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(), now + DAY, token, now, now, 'm1').run()
  return `better-auth.session_token=${await hmacSigned(token, env.BETTER_AUTH_SECRET)}`
}
const admin = (cookie: string, method: string, path: string, body?: unknown) =>
  h.fetch(`/api/admin${path}`, {
    method,
    headers: { Cookie: cookie, Origin: 'http://localhost:8787', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const json = async (r: Response) => (await r.json()) as any

describe('team creator: titles, targets, optional support in the `all` group', () => {
  it('stores a normalised title and publishes it; the target and an absent support are accepted', async () => {
    const res = await post(h, 'all', submitBody({ title: '  ＳＳＳ   auto  ', payload: goodTeam({ target: 'quest-616001' }) }))
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(202)
    const [row] = await rows()
    expect(row).toMatchObject({ title: 'SSS auto', group_id: 'all' })
    expect(JSON.parse(row!.payload as string)).toMatchObject({ target: 'quest-616001', supportIndex: null })

    const cookie = await login()
    const approve = await admin(cookie, 'POST', `/submissions/${row!.id}/state`, { expectedVersion: 1, state: 'approved' })
    expect(approve.status).toBe(200)
    const blob = await json(await h.fetch(`/api/v1/submissions/${TYPE}/all`))
    expect(blob.items[0]).toMatchObject({ title: 'SSS auto', tags: { teamType: 'manual', successRate: 'high' } })
    expect(blob.groupOptions.targets).toHaveLength(2)
    expect(await env.KV.get(`pub:${PUBLISH_REV}:${TYPE}:all`)).toBeTruthy()
  })

  it('reports title errors with codes and rejects unknown targets', async () => {
    const bad = async (over: Record<string, unknown>) => {
      const r = await post(h, 'all', submitBody(over))
      expect(r.status).toBe(400)
      return ((await json(r)).error.fields as { path: string; code: string }[]).map((f) => `${f.path}:${f.code}`)
    }
    expect(await bad({ title: '' })).toEqual(['title:title_required'])
    expect(await bad({ title: undefined })).toEqual(['title:title_required'])
    expect(await bad({ title: 'abc' })).toEqual(['title:title_too_short'])
    expect(await bad({ title: 'x'.repeat(51) })).toEqual(['title:title_too_long'])
    expect(await bad({ title: 'visit example.com' })).toEqual(['title:title_link'])
    expect(await bad({ payload: goodTeam({ target: 'nope' }) })).toEqual(['payload.target:target_unknown'])
    expect(await rows()).toHaveLength(0)
  })

  it('exposes the title rules and the tag default in the type config', async () => {
    const cfg = await json(await h.fetch(`/api/v1/types/${TYPE}`))
    expect(cfg.title).toMatchObject({ required: true, minLength: 4, maxLength: 50 })
    expect(cfg.tags.find((t: { key: string }) => t.key === 'teamType').default).toBe('manual')
    expect(cfg.tags.find((t: { key: string }) => t.key === 'successRate').default).toBeUndefined()
  })

  it('does not fill a default tag in server-side (required is still enforced)', async () => {
    const r = await post(h, 'all', submitBody({ tags: { successRate: 'high' } }))
    expect(r.status).toBe(400)
    expect(JSON.stringify(await r.json())).toContain('tags.teamType')
  })

  it('a moderator can edit the title (audited, original kept, validated); legacy untitled rows need one to be edited', async () => {
    const cookie = await login()
    const res = await post(h, 'all', submitBody())
    const id = (await json(res)).id as string
    await env.DB.prepare("UPDATE submission_tab SET title='' WHERE id=?").bind(id).run() // simulate a legacy row

    const noTitle = await admin(cookie, 'PATCH', `/submissions/${id}`, { expectedVersion: 1, explanation: 'edited' })
    expect(noTitle.status).toBe(400)
    expect(JSON.stringify(await json(noTitle))).toContain('title_required')

    const ok = await admin(cookie, 'PATCH', `/submissions/${id}`, { expectedVersion: 1, title: 'Quartz S 2-turn' })
    expect(ok.status).toBe(200)
    const item = (await json(ok)).item
    expect(item).toMatchObject({ title: 'Quartz S 2-turn', version: 2 })
    expect(item.original.title).toBe('')
    const audit = await json(await admin(cookie, 'GET', '/audit'))
    const edit = audit.entries.find((a: { action: string }) => a.action === 'submission.edit')
    expect(edit.detail.changed).toContain('title')
    const list = await json(await admin(cookie, 'GET', `/types/${TYPE}/submissions?state=pending`))
    expect(list.items[0].title).toBe('Quartz S 2-turn')
  })

  it('republishes `all` when the registry changes its targets (a wiki-only change)', async () => {
    await runHousekeeping(env, h.purge, Date.now())
    const changed = structuredClone(REGISTRY) as unknown as { groups: Record<string, { options: { targets: unknown[] } }> }
    changed.groups.all!.options.targets.push({ id: 'rogue-2610', label: { en: 'New boss' } })
    ;(globalThis.fetch as unknown as { mockImplementation: (f: unknown) => void }).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('https://challenges.cloudflare.com/')) return new Response(JSON.stringify({ success: true }))
      return url === 'https://wiki.test/api/cms-groups.json' ? new Response(JSON.stringify(changed)) : new Response('nf', { status: 404 })
    })
    h.purge.mockClear()
    const r = await runHousekeeping(env, h.purge, Date.now() + 1000)
    expect(r.groupsRepublished).toBe(1)
    expect(h.purge).toHaveBeenCalledWith({ tags: [`pub:${TYPE}:all`] })
    const blob = JSON.parse((await env.KV.get(`pub:${PUBLISH_REV}:${TYPE}:all`))!)
    expect(blob.groupOptions.targets.map((t: { id: string }) => t.id)).toEqual(['quest-616001', 'quest-605001', 'rogue-2610'])
    // The new target is accepted by the validator right away.
    const ok = await post(h, 'all', submitBody({ payload: goodTeam({ target: 'rogue-2610' }) }))
    expect(ok.status).toBe(202)
  })
})
