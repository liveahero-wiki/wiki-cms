import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { refreshRoster } from '../src/core/groups.ts'
import { getType } from '../src/core/types-runtime.ts'
import { GROUPS_URL, ORIGIN, contribApi, contribLogin, extraFetch, makeHarness, resetState, rows, seedType, sessionCookie, type Harness } from './helpers.ts'

const VOICE = 'lah-voice-tl'
const BIO = 'lah-bio-tl'
const CLI = { Authorization: 'Bearer test-cli-token' }

const VOICE_ROSTER = {
  version: '1',
  resources: { ryekie: { voice_ryekie_action: { jp: 'よし', en: "Let's go!" }, voice_ryekie_win: { jp: '勝った' } } },
}
const BIO_ROSTER = { version: '1', bios: { DETAIL_CEPH_H01: { jp: 'x' }, bio_s01: { jp: 'y' } } }

let h: Harness
let clock = Date.now()
const json = async <T = any>(r: Response) => (await r.json()) as T

beforeEach(async () => {
  await resetState()
  clock = Date.now()
  h = makeHarness({ now: () => clock })
  // D1 says anonymous: `accountOnly` in the type definition must win.
  await seedType(VOICE, { submitAuth: 'anonymous' })
  await seedType(BIO, { submitAuth: 'anonymous' })
  extraFetch.set(new URL('/api/voice-roster.json', GROUPS_URL).toString(), VOICE_ROSTER)
  extraFetch.set(new URL('/api/bio-roster.json', GROUPS_URL).toString(), BIO_ROSTER)
  await loadRosters()
})

/** The roster is read from KV (written by the hourly refresh), so fetch it once like the cron would. */
async function loadRosters() {
  for (const id of [VOICE, BIO]) expect(await refreshRoster(env, id, (await getType(env, id))!)).toBe(true)
}

let ipSeq = 0
const line = (part: string, over: Record<string, unknown> = {}) => ({ key: `voice_ryekie_${part}`, base: "Let's go!", text: 'Here we go!', ...over })
const voice = (over: Record<string, unknown> = {}) => ({ resourceName: 'ryekie', lines: [line('action')], ...over })
const bio = (over: Record<string, unknown> = {}) => ({ key: 'DETAIL_CEPH_H01', base: '', text: 'A fine bio.', ...over })
const body = (payload: unknown) => ({ payload, tags: {}, lang: 'en', turnstileToken: 'tok', website: '' })

const submit = (token: string | null, type: string, payload: unknown, extra: Record<string, unknown> = {}) =>
  contribApi(h, token, 'POST', `/submissions/${type}/all`, { ...body(payload), ...extra }, { 'CF-Connecting-IP': `203.0.113.${100 + (ipSeq++ % 100)}` })

const admin = (cookie: string, method: string, path: string, b?: unknown) =>
  h.fetch(`/api/admin${path}`, {
    method,
    headers: { Cookie: cookie, Origin: 'http://localhost:8787', ...(b !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(b !== undefined ? { body: JSON.stringify(b) } : {}),
  })

const internalGet = (type: string, token: string | null = 'test-cli-token', q = '') =>
  h.fetch(`/api/internal/submissions/${type}${q}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
const internalExternal = (type: string, b: unknown) =>
  h.fetch(`/api/internal/submissions/${type}/external`, { method: 'POST', headers: { ...CLI, 'Content-Type': 'application/json' }, body: JSON.stringify(b) })

async function approve(type: string, id: string, version = 1) {
  const mod = await sessionCookie('mod', { types: [VOICE, BIO] })
  const res = await admin(mod, 'POST', `/submissions/${id}/state`, { expectedVersion: version, state: 'approved' })
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
  return mod
}

describe('lah-voice-tl', () => {
  it('a contributor submits a batch; it is stored normalized, pending, owned, with no title/explanation/demo', async () => {
    const token = await contribLogin('c1', { displayName: 'Alice' })
    const res = await submit(token, VOICE, voice({ lines: [line('action', { text: '  Here we go!\r\nGo!  ' }), line('win', { base: '', text: 'We won!' })], note: ' thanks ' }))
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(202)
    const { id } = await json(res)
    const [row] = await rows(`id='${id}'`)
    expect(row).toMatchObject({ type: VOICE, group_id: 'all', state: 'pending', lang: 'en', title: '', explanation: '', explanation_html: '', demo_url: '', user_id: 'c1', external: null })
    expect(JSON.parse(row!.payload as string)).toEqual({
      resourceName: 'ryekie',
      lines: [
        { key: 'voice_ryekie_action', base: "Let's go!", text: 'Here we go!\nGo!' },
        { key: 'voice_ryekie_win', base: '', text: 'We won!' },
      ],
      note: 'thanks',
    })
  })

  it('validation errors carry paths and codes, including the roster checks', async () => {
    const token = await contribLogin('c1')
    const bad = await submit(token, VOICE, voice({ lines: [line('action', { text: '<b>x</b>' }), line('lose'), line('win', { base: 'same', text: 'same' })] }))
    expect(bad.status).toBe(400)
    const fields = (await json(bad)).error.fields as { path: string; code: string }[]
    expect(fields).toEqual(
      expect.arrayContaining([
        { path: 'payload.lines.0.text', code: 'text_invalid', message: expect.any(String) },
        { path: 'payload.lines.1.key', code: 'line_not_translatable', message: expect.any(String) },
        { path: 'payload.lines.2.text', code: 'text_same_as_base', message: expect.any(String) },
      ]),
    )
    const unknown = await submit(token, VOICE, { resourceName: 'nobody', lines: [{ key: 'voice_nobody_a', base: '', text: 'x' }] })
    expect((await json(unknown)).error.fields.map((f: { code: string }) => f.code)).toEqual(['unknown_resource'])
    expect(await rows()).toHaveLength(0)
  })

  it('the roster check is soft: an unavailable roster does not block a submission', async () => {
    await resetState()
    await seedType(VOICE)
    const token = await contribLogin('c1')
    expect((await submit(token, VOICE, voice({ lines: [line('anything')] }))).status).toBe(202)
  })

  it('anonymous POST is refused even though D1 says anonymous', async () => {
    const res = await h.fetch(`/api/v1/submissions/${VOICE}/all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.9' },
      body: JSON.stringify(body(voice())),
    })
    expect(res.status).toBe(401)
    expect((await json(res)).error.code).toBe('account_required')
    expect(await rows()).toHaveLength(0)
    expect((await submit(null, VOICE, voice())).status).toBe(401)
  })

  it('cannot be edited by the contributor (PUT is 403 not_editable)', async () => {
    const token = await contribLogin('c1')
    const { id } = await json(await submit(token, VOICE, voice()))
    const put = await contribApi(h, token, 'PUT', `/submissions/${id}`, { ...body(voice({ lines: [line('action', { text: 'Other' })] })), expectedVersion: 1 })
    expect(put.status).toBe(403)
    expect((await json(put)).error.code).toBe('not_editable')
  })

  it('has no public list, and its config shows no explanation or demo link', async () => {
    expect((await h.fetch(`/api/v1/submissions/${VOICE}/all`)).status).toBe(404)
    const res = await h.fetch(`/api/v1/types/${VOICE}`)
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ type: VOICE, explanation: null, demoUrl: null, title: null, tags: [], submitAuth: 'account', langs: [{ value: 'en', label: 'English' }] })
  })

  it('accepts a body over 32 KB (up to the type cap) and refuses one over its cap', async () => {
    const token = await contribLogin('c1')
    const lines = Array.from({ length: 60 }, (_, i) => line(`p${i}`, { base: '', text: 't'.repeat(1000) }))
    expect(JSON.stringify(body(voice({ lines }))).length).toBeGreaterThan(32 * 1024)
    const keys = Object.fromEntries(lines.map((l) => [l.key, { jp: 'x' }]))
    extraFetch.set(new URL('/api/voice-roster.json', GROUPS_URL).toString(), { version: '2', resources: { ryekie: keys } })
    await loadRosters()
    expect((await submit(token, VOICE, voice({ lines }))).status).toBe(202)
    const huge = await submit(token, VOICE, voice({ note: 'n'.repeat(450 * 1024) }))
    expect(huge.status).toBe(413)
    expect((await json(huge)).error.code).toBe('too_large')
  })

  it('more than 100 lines is refused', async () => {
    const token = await contribLogin('c1')
    const res = await submit(token, VOICE, voice({ lines: Array.from({ length: 101 }, (_, i) => line(`p${i}`, { base: '' })) }))
    expect(res.status).toBe(400)
    expect((await json(res)).error.fields[0].code).toBe('lines_length')
  })

  it('approval writes no public blob and purges nothing', async () => {
    const token = await contribLogin('c1')
    const { id } = await json(await submit(token, VOICE, voice()))
    await approve(VOICE, id)
    expect((await rows(`id='${id}'`))[0]!.state).toBe('approved')
    expect((await env.KV.list({ prefix: 'pub:' })).keys).toHaveLength(0)
    expect(h.purge).not.toHaveBeenCalled()
  })
})

describe('lah-bio-tl', () => {
  it('a contributor submits one bio', async () => {
    const token = await contribLogin('c1')
    const res = await submit(token, BIO, bio({ text: ' Line one\r\nLine two ' }))
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(202)
    const { id } = await json(res)
    const [row] = await rows(`id='${id}'`)
    expect(row).toMatchObject({ type: BIO, state: 'pending', user_id: 'c1', explanation: '' })
    expect(JSON.parse(row!.payload as string)).toEqual({ key: 'DETAIL_CEPH_H01', base: '', text: 'Line one\nLine two' })
  })

  it('rejects a bio that is not translatable, markup and an unchanged text', async () => {
    const token = await contribLogin('c1')
    const codes = async (payload: unknown) => (await json(await submit(token, BIO, payload))).error.fields.map((f: { path: string; code: string }) => `${f.path}:${f.code}`)
    expect(await codes(bio({ key: 'DETAIL_OTHER_H01' }))).toEqual(['payload.key:bio_not_translatable'])
    expect(await codes(bio({ text: '{{ evil }}' }))).toEqual(['payload.text:text_invalid'])
    expect(await codes(bio({ base: 'Same', text: 'Same' }))).toEqual(['payload.text:text_same_as_base'])
  })

  it('same hard rules as voice: account-only, not editable, not public', async () => {
    expect((await submit(null, BIO, bio())).status).toBe(401)
    const token = await contribLogin('c1')
    const { id } = await json(await submit(token, BIO, bio()))
    const put = await contribApi(h, token, 'PUT', `/submissions/${id}`, { ...body(bio({ text: 'Other' })), expectedVersion: 1 })
    expect(put.status).toBe(403)
    expect((await h.fetch(`/api/v1/submissions/${BIO}/all`)).status).toBe(404)
    expect(await json(await h.fetch(`/api/v1/types/${BIO}`))).toMatchObject({ explanation: null, demoUrl: null, submitAuth: 'account' })
  })
})

describe('internal API for the intake Action', () => {
  it('requires the CLI token', async () => {
    expect((await internalGet(VOICE, null)).status).toBe(401)
    expect((await internalGet(VOICE, 'wrong')).status).toBe(401)
    const mod = await sessionCookie('mod', { types: [VOICE] })
    expect((await h.fetch(`/api/internal/submissions/${VOICE}`, { headers: { Cookie: mod } })).status).toBe(401)
    expect((await h.fetch(`/api/internal/submissions/${VOICE}/external`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401)
    expect((await internalGet('nope-type')).status).toBe(404)
  })

  it('lists only approved rows that have no external result, oldest first, with the display name', async () => {
    const alice = await contribLogin('c1', { displayName: 'Alice' })
    const bob = await contribLogin('c2', { displayName: 'Bob' })
    const first = (await json(await submit(alice, VOICE, voice()))).id
    clock += 1000
    const second = (await json(await submit(bob, VOICE, voice({ lines: [line('win', { base: '', text: 'We won!' })] })))).id
    await submit(alice, VOICE, voice({ lines: [line('action', { text: 'Pending one' })] }))
    expect((await json(await internalGet(VOICE))).items).toEqual([])
    await approve(VOICE, second)
    clock += 1000
    await approve(VOICE, first)
    const { items } = await json(await internalGet(VOICE))
    expect(items.map((i: { id: string }) => i.id)).toEqual([second, first]) // by approval time
    expect(items[0]).toMatchObject({ id: second, version: 2, groupId: 'all', lang: 'en', displayName: 'Bob', payload: { resourceName: 'ryekie', lines: [{ key: 'voice_ryekie_win', base: '', text: 'We won!' }] } })
    expect(items[0].approvedAt).toEqual(expect.any(Number))
    expect(items[1]).toMatchObject({ id: first, displayName: 'Alice' })
    expect(JSON.stringify(items)).not.toContain('203.0.113')
    expect((await json(await internalGet(VOICE, 'test-cli-token', '?limit=1'))).items).toHaveLength(1)
    expect((await json(await internalGet(BIO))).items).toEqual([]) // per type
  })

  it('stores the result; the owner sees only the outcome; a repeated post is skipped and nothing is re-listed', async () => {
    const token = await contribLogin('c1', { displayName: 'Alice' })
    const { id } = await json(await submit(token, VOICE, voice()))
    await approve(VOICE, id)
    const external = { outcome: { status: 'synced', label: 'In the sheet' }, written: ['voice_ryekie_action'], conflicts: [] }
    const res = await internalExternal(VOICE, { results: [{ id, external }, { id: 'unknown-id', external }] })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ stored: [id], skipped: ['unknown-id'] })
    const [row] = await rows(`id='${id}'`)
    expect(JSON.parse(row!.external as string)).toEqual(external)
    expect(row!.external_at).toEqual(expect.any(Number))

    const mine = await json(await contribApi(h, token, 'GET', `/submissions?type=${VOICE}`))
    expect(mine.items[0].outcome).toEqual({ status: 'synced', label: 'In the sheet' })
    expect(JSON.stringify(mine)).not.toContain('written')

    const again = await json(await internalExternal(VOICE, { results: [{ id, external: { outcome: { status: 'conflict' } } }] }))
    expect(again).toEqual({ stored: [], skipped: [id] })
    expect(JSON.parse((await rows(`id='${id}'`))[0]!.external as string).outcome.status).toBe('synced')
    expect((await json(await internalGet(VOICE))).items).toEqual([])
  })

  it('does not store results for pending rows or rows of another type, and rejects bad input', async () => {
    const token = await contribLogin('c1')
    const pending = (await json(await submit(token, VOICE, voice()))).id
    const other = (await json(await submit(token, BIO, bio()))).id
    await approve(BIO, other)
    const ok = { outcome: { status: 'synced' } }
    expect(await json(await internalExternal(VOICE, { results: [{ id: pending, external: ok }, { id: other, external: ok }] }))).toEqual({ stored: [], skipped: [pending, other] })
    for (const bad of [{}, { results: [] }, { results: [{ external: ok }] }, { results: [{ id: pending, external: 'x' }] }, { results: [{ id: pending, external: { outcome: { status: 'Bad Status' } } }] }]) {
      expect((await internalExternal(VOICE, bad)).status).toBe(400)
    }
    expect((await h.fetch(`/api/internal/submissions/${VOICE}/external`, { method: 'POST', headers: { ...CLI, 'Content-Type': 'application/json' }, body: 'nope' })).status).toBe(400)
  })

  it('a moderator editing the payload of a conflicting row re-queues it; other outcomes are left alone', async () => {
    const token = await contribLogin('c1')
    const a = (await json(await submit(token, VOICE, voice()))).id
    const b = (await json(await submit(token, VOICE, voice({ lines: [line('win', { base: '', text: 'We won!' })] })))).id
    const mod = await approve(VOICE, a)
    await approve(VOICE, b)
    const conflict = { outcome: { status: 'conflict', label: 'Sheet changed' }, conflicts: [{ key: 'voice_ryekie_action', base: "Let's go!", current: 'Hey!' }] }
    await internalExternal(VOICE, { results: [{ id: a, external: conflict }, { id: b, external: { outcome: { status: 'synced' } } }] })
    expect((await json(await internalGet(VOICE))).items).toEqual([])

    // The owner sees the conflict; the moderator edits the line.
    expect((await json(await contribApi(h, token, 'GET', `/submissions?type=${VOICE}`))).items.find((i: { id: string }) => i.id === a).outcome.status).toBe('conflict')
    const edit = await admin(mod, 'PATCH', `/submissions/${a}`, { expectedVersion: 2, payload: voice({ lines: [line('action', { base: 'Hey!', text: 'Let us go!' })] }) })
    expect(edit.status, JSON.stringify(await edit.clone().json())).toBe(200)
    expect((await json(edit)).item).toMatchObject({ external: null, externalAt: null, state: 'approved', version: 3 })
    const queue = (await json(await internalGet(VOICE))).items
    expect(queue.map((i: { id: string }) => i.id)).toEqual([a])
    expect(queue[0].payload.lines[0]).toEqual({ key: 'voice_ryekie_action', base: 'Hey!', text: 'Let us go!' })

    // A row whose outcome is not a conflict keeps its result, and so does a conflict edited without a payload change.
    const syncedEdit = await admin(mod, 'PATCH', `/submissions/${b}`, { expectedVersion: 2, payload: voice({ lines: [line('win', { base: '', text: 'We did win!' })] }) })
    expect((await json(syncedEdit)).item.external.outcome.status).toBe('synced')
    await internalExternal(VOICE, { results: [{ id: a, external: conflict }] })
    const noPayload = await admin(mod, 'PATCH', `/submissions/${a}`, { expectedVersion: 3, lang: 'en' })
    expect((await json(noPayload)).item.external.outcome.status).toBe('conflict')
  }, 30_000)

  it('editing the payload of a partially synced row re-queues it too', async () => {
    const token = await contribLogin('c1')
    const a = (await json(await submit(token, VOICE, voice()))).id
    const mod = await approve(VOICE, a)
    await internalExternal(VOICE, { results: [{ id: a, external: { outcome: { status: 'partial' }, written: ['voice_ryekie_win'], conflicts: [{ key: 'voice_ryekie_action', base: 'x', current: 'y' }] } }] })
    const edit = await admin(mod, 'PATCH', `/submissions/${a}`, { expectedVersion: 2, payload: voice({ lines: [line('action', { base: 'y', text: 'Let us go!' })] }) })
    expect(edit.status, JSON.stringify(await edit.clone().json())).toBe(200)
    expect((await json(edit)).item).toMatchObject({ external: null, externalAt: null })
  }, 30_000)

  it('the admin list shows the stored result to moderators', async () => {
    const token = await contribLogin('c1')
    const { id } = await json(await submit(token, VOICE, voice()))
    const mod = await approve(VOICE, id)
    await internalExternal(VOICE, { results: [{ id, external: { outcome: { status: 'synced' }, written: ['voice_ryekie_action'] } }] })
    const list = await json(await admin(mod, 'GET', `/types/${VOICE}/submissions?state=approved`))
    expect(list.items[0].external).toEqual({ outcome: { status: 'synced' }, written: ['voice_ryekie_action'] })
  })
})
