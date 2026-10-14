import { PUBLISH_REV } from '../src/config.ts'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { republish } from '../src/core/publish.ts'
import { getType } from '../src/core/types-runtime.ts'
import { TYPE, ORIGIN, goodTeam, makeHarness, post, resetState, rows, submitBody, type Harness } from './helpers.ts'

let h: Harness
beforeEach(async () => {
  await resetState()
  h = makeHarness()
})

async function insertApproved(id: string, group: string, createdAt: number, extra: Record<string, unknown> = {}) {
  await env.DB.prepare(
    `INSERT INTO submission_tab (id,type,group_id,state,version,payload,tags,lang,explanation,explanation_html,demo_url,created_at,updated_at,state_changed_at,ip,ip_key,country,original,moderated_by,ai_verdict)
     VALUES (?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id, TYPE, group, extra.state ?? 'approved', JSON.stringify(goodTeam()), '{"teamType":"manual","successRate":"medium"}', 'en', 'md', `<p>${id}</p>`,
      'https://youtu.be/x', createdAt, createdAt, createdAt, '9.9.9.9', '9.9.9.9', 'JP', '{"secret":1}', 'mod-1', 'ok',
    )
    .run()
}

describe('POST /api/v1/submissions', () => {
  it('stores a pending row (happy path) and returns 202', async () => {
    const res = await post(h, 'quest-1', submitBody())
    expect(res.status).toBe(202)
    const json = (await res.json()) as { id: string; state: string }
    expect(json.state).toBe('pending')
    const r = await rows()
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ id: json.id, state: 'pending', group_id: 'quest-1', ip: '203.0.113.9', ip_key: '203.0.113.9', lang: 'en' })
    expect(r[0]!.explanation_html).toContain('<h4>Overview</h4>')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('accepts an external https link and stores it with the visible host', async () => {
    const res = await post(h, 'quest-1', submitBody({ explanation: 'Full guide: [my guide](https://www.notion.so/guide?utm_source=x)' }))
    expect(res.status).toBe(202)
    const html = String((await rows())[0]!.explanation_html)
    expect(html).toContain('<a class="cms-ext" href="https://www.notion.so/guide" target="_blank" rel="noopener noreferrer nofollow ugc">my guide <span class="cms-ext-host">notion.so ↗</span></a>')
  })

  it('rejects deceptive, shortened and surplus links with specific codes', async () => {
    const codes = async (explanation: string) => {
      const res = await post(h, 'quest-1', submitBody({ explanation }))
      expect(res.status).toBe(400)
      return ((await res.json()) as { error: { fields: { code: string }[] } }).error.fields.map((f) => f.code)
    }
    expect(await codes('[youtube.com](https://evil.example.org/x)')).toEqual(['md_link_text'])
    expect(await codes('[go](https://bit.ly/abc)')).toEqual(['md_link_invalid'])
    expect(await codes('[1](https://a.example.com) [2](https://b.example.com) [3](https://c.example.com) [4](https://d.example.com)')).toEqual(['md_link_limit'])
    expect(await rows()).toHaveLength(0)
  })

  it('rejects a bad or missing Origin with 403', async () => {
    expect((await post(h, 'quest-1', submitBody(), { Origin: 'https://evil.example' })).status).toBe(403)
    const res = await h.fetch(`/api/v1/submissions/${TYPE}/quest-1`, { method: 'POST', body: JSON.stringify(submitBody()) })
    expect(res.status).toBe(403)
    expect(await rows()).toHaveLength(0)
  })

  it('honeypot returns 202 without storing', async () => {
    const res = await post(h, 'quest-1', submitBody({ website: 'http://spam' }))
    expect(res.status).toBe(202)
    expect(await rows()).toHaveLength(0)
  })

  it('blocked IP gets 403 (IPv6 blocks match the /64)', async () => {
    await env.DB.prepare('INSERT INTO ip_block_tab (ip_key,reason,created_by,created_at) VALUES (?,?,?,?)').bind('2001:db8:1:2::', 'x', 'cli', 1).run()
    const res = await post(h, 'quest-1', submitBody(), { 'CF-Connecting-IP': '2001:db8:1:2:aaaa::1' })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ip_blocked')
    expect((await post(h, 'quest-1', submitBody(), { 'CF-Connecting-IP': '2001:db8:1:3::1' })).status).toBe(202)
  })

  it('aggregates all validation errors with codes', async () => {
    const res = await post(h, 'quest-1', submitBody({
      payload: goodTeam({ supportIndex: 0 }),
      tags: {},
      title: '',
      lang: 'xx',
      explanation: 'see [a](http://x.example.com)',
      demoUrl: 'https://evil.com/v',
    }))
    expect(res.status).toBe(400)
    const { error } = (await res.json()) as { error: { fields: { path: string; code: string }[] } }
    const got = error.fields.map((f) => `${f.path}:${f.code}`).sort()
    expect(got).toEqual(
      ['demoUrl:demo_host', 'explanation:md_link_invalid','lang:lang_invalid', 'payload.supportIndex:support_not_allowed', 'tags.successRate:tag_required', 'tags.teamType:tag_required', 'title:title_required'].sort(),
    )
    expect(await rows()).toHaveLength(0)
  })

  it('applies group-level rules: support group requires supportIndex; focus group requires the card', async () => {
    const r1 = await post(h, 'quest-2', submitBody())
    expect(r1.status).toBe(400)
    expect(JSON.stringify(await r1.json())).toContain('support_required')
    const r2 = await post(h, 'hero-10251', submitBody({ payload: goodTeam({ supportIndex: 0 }) }))
    expect(JSON.stringify(await r2.json())).toContain('focus_missing')
    const r3 = await post(h, 'hero-10251', submitBody({ payload: { v: 1, supportIndex: 1, heroes: [{ stockId: 10251 }, { stockId: 10021 }] } }))
    expect(r3.status).toBe(202)
  })

  it('rejects unknown groups with 404 and malformed JSON with 400', async () => {
    expect((await post(h, 'nope', submitBody())).status).toBe(404)
    const res = await h.fetch(`/api/v1/submissions/${TYPE}/quest-1`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: '{bad',
    })
    expect(res.status).toBe(400)
  })

  it('rejects oversized bodies with 413', async () => {
    const res = await post(h, 'quest-1', submitBody({ explanation: 'x'.repeat(40_000) }))
    expect(res.status).toBe(413)
  })

  it('fails when Turnstile fails', async () => {
    await resetState({ turnstile: false })
    h = makeHarness()
    const res = await post(h, 'quest-1', submitBody())
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('turnstile_failed')
  })

  it('enforces the per-IP daily cap and the pending cap', async () => {
    for (let i = 0; i < 10; i++) expect((await post(h, 'quest-1', submitBody({ explanation: `e${i}` }), { 'CF-Connecting-IP': '198.51.100.1' })).status).toBe(202)
    const res = await post(h, 'quest-1', submitBody(), { 'CF-Connecting-IP': '198.51.100.1' })
    expect(res.status).toBe(429)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('daily_cap')
  })
})

describe('GET /api/v1/submissions/:type/:group', () => {
  it('returns only approved items, newest first, without private fields; carries cache headers + tag', async () => {
    await insertApproved('old', 'quest-1', 1000)
    await insertApproved('new', 'quest-1', 2000)
    await insertApproved('pend', 'quest-1', 3000, { state: 'pending' })
    await insertApproved('spam', 'quest-1', 3500, { state: 'spam' })
    await insertApproved('other', 'quest-2', 4000)
    const res = await h.fetch(`/api/v1/submissions/${TYPE}/quest-1`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { id: string }[]; groupOptions: unknown; group: string }
    expect(body.items.map((i) => i.id)).toEqual(['new', 'old'])
    expect(body.groupOptions).toEqual({ support: false })
    const text = JSON.stringify(body)
    for (const secret of ['9.9.9.9', 'JP', 'mod-1', 'secret', 'ip_key', 'country', 'moderat', 'ai_']) expect(text).not.toContain(secret)
    expect(res.headers.get('Cache-Tag')).toBe(`pub:${TYPE}:quest-1`)
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=86400')
    expect(res.headers.get('CDN-Cache-Control')).toBe('public, max-age=86400')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    const etag = res.headers.get('ETag')!
    expect(etag).toBeTruthy()
    const again = await h.fetch(`/api/v1/submissions/${TYPE}/quest-1`, { headers: { 'If-None-Match': etag } })
    expect(again.status).toBe(304)
  })

  it('unknown group: empty blob, short TTL, no tag and no CDN TTL', async () => {
    const res = await h.fetch(`/api/v1/submissions/${TYPE}/not-a-group`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { items: unknown[] }).items).toEqual([])
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60')
    expect(res.headers.get('Cache-Tag')).toBeNull()
    expect(res.headers.get('CDN-Cache-Control')).toBeNull()
    expect((await env.KV.list()).keys.filter((k) => k.name.startsWith('pub:'))).toHaveLength(0)
  })

  it('rejects malformed group ids and unknown types', async () => {
    expect((await h.fetch(`/api/v1/submissions/${TYPE}/Bad_Group!`)).status).toBe(404)
    expect((await h.fetch(`/api/v1/submissions/nope/quest-1`)).status).toBe(404)
  })

  it('fills KV on miss and serves it afterwards', async () => {
    await insertApproved('a', 'quest-1', 1000)
    await h.fetch(`/api/v1/submissions/${TYPE}/quest-1`)
    const keys = (await env.KV.list({ prefix: 'pub:' })).keys
    expect(keys).toHaveLength(1)
    // Mutate D1; the blob is still served from KV until republished.
    await insertApproved('b', 'quest-1', 2000)
    const body = (await (await h.fetch(`/api/v1/submissions/${TYPE}/quest-1`)).json()) as { items: unknown[] }
    expect(body.items).toHaveLength(1)
  })
})

describe('GET /api/v1/types/:type', () => {
  it('returns form config with cache headers and tag', async () => {
    const res = await h.fetch(`/api/v1/types/${TYPE}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tags: { options: { label: Record<string, string> }[] }[]; explanation: { template: Record<string, string> }; turnstileSiteKey: string }
    expect(Object.keys(body.explanation.template).sort()).toEqual(['en', 'ja', 'zh-Hans', 'zh-Hant'])
    expect(body.tags[0]!.options[0]!.label.ja).toBeTruthy()
    expect(body.turnstileSiteKey).toBeTruthy()
    expect(res.headers.get('Cache-Tag')).toBe(`cfg:${TYPE}`)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600')
  })
})

describe('CORS preflight', () => {
  it('allows only configured origins', async () => {
    const ok = await h.fetch(`/api/v1/submissions/${TYPE}/quest-1`, { method: 'OPTIONS', headers: { Origin: ORIGIN } })
    expect(ok.status).toBe(204)
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
    const bad = await h.fetch(`/api/v1/submissions/${TYPE}/quest-1`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })
    expect(bad.status).toBe(403)
  })
})

describe('no-store policy', () => {
  it('health, unknown api paths and errors are never cached', async () => {
    expect((await h.fetch('/api/health')).headers.get('Cache-Control')).toBe('private, no-store')
    const nf = await h.fetch('/api/nope')
    expect(nf.status).toBe(404)
    expect(nf.headers.get('Cache-Control')).toBe('private, no-store')
  })
})

describe('republish', () => {
  it('rebuilds the blob and purges the group tag; purge failure does not throw', async () => {
    const rt = (await getType(env, TYPE))!
    await insertApproved('a', 'quest-1', 1000)
    const r = await republish(env, TYPE, rt, 'quest-1', h.purge)
    expect(h.purge).toHaveBeenCalledWith({ tags: [`pub:${TYPE}:quest-1`] })
    expect(r.purge.success).toBe(true)
    const blob = JSON.parse((await env.KV.get(`pub:${PUBLISH_REV}:${TYPE}:quest-1`))!) as { items: { id: string }[] }
    expect(blob.items.map((i) => i.id)).toEqual(['a'])

    await insertApproved('b', 'quest-1', 2000)
    h.purge.mockResolvedValueOnce({ success: false, errors: [{ code: 1, message: 'rate' }] })
    const r2 = await republish(env, TYPE, rt, 'quest-1', h.purge)
    expect(r2.purge.success).toBe(false)
    const blob2 = JSON.parse((await env.KV.get(`pub:${PUBLISH_REV}:${TYPE}:quest-1`))!) as { items: { id: string }[] }
    expect(blob2.items.map((i) => i.id)).toEqual(['b', 'a'])

    h.purge.mockRejectedValueOnce(new Error('boom'))
    expect((await republish(env, TYPE, rt, 'quest-1', h.purge)).purge.success).toBe(false)
  })

  it('removes the KV blob for a group that left the registry', async () => {
    const rt = (await getType(env, TYPE))!
    await env.KV.put(`pub:${PUBLISH_REV}:${TYPE}:gone`, '{}')
    await republish(env, TYPE, rt, 'gone', h.purge)
    expect(await env.KV.get(`pub:${PUBLISH_REV}:${TYPE}:gone`)).toBeNull()
  })
})
