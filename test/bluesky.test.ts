import { env } from 'cloudflare:workers'
import { JoseKey } from '@atproto/jwk-jose'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BSKY_STATE_TTL_MS, CONTRIB_MIN_ACCOUNT_AGE_DAYS } from '../src/config.ts'
import { AtprotoError, createAtprotoClient, d1StateStore, type AtprotoAuth, type FlowState } from '../src/core/atproto.ts'
import { normalizeHandleInput } from '../src/core/bluesky.ts'
import { runHousekeeping } from '../src/core/housekeeping.ts'
import { DAY, ORIGIN, TYPE, contribApi, makeHarness, resetState, sessionCookie, type Harness } from './helpers.ts'

const DID = 'did:plc:abcdefghijklmnopqrstuvwx'
const SELF = 'http://localhost:8787'
const json = async <T = any>(r: Response) => (await r.json()) as T

let h: Harness
let clock = Date.now()

// ---- fakes -------------------------------------------------------------------------------------------------------------

/** Replaces the OAuth client: `authorize` stores the flow state, `callback` consumes it and returns `next.did`. */
const oauth = {
  states: new Map<string, FlowState>(),
  authorized: [] as { handle: string; state: FlowState }[],
  callbackParams: [] as URLSearchParams[],
  did: DID,
  authorizeError: undefined as unknown,
  callbackError: undefined as unknown,
}
const fakeAuth = (): AtprotoAuth => ({
  authorize: async (handle, state) => {
    if (oauth.authorizeError) throw oauth.authorizeError
    oauth.authorized.push({ handle, state })
    const key = `state-${oauth.authorized.length}`
    oauth.states.set(key, state)
    return `https://bsky.social/oauth/authorize?request_uri=${key}`
  },
  peekState: async (key) => oauth.states.get(key) ?? null,
  callback: async (params) => {
    oauth.callbackParams.push(params)
    if (oauth.callbackError) throw oauth.callbackError
    oauth.states.delete(params.get('state') ?? '')
    return { did: oauth.did }
  },
})

/** PLC audit log + AppView profile; anything else falls through to the shared test stub. */
const net = {
  plc: { status: 200, body: undefined as unknown },
  plcThrows: false,
  profile: { status: 200, body: {} as unknown },
  calls: [] as string[],
}
const plcLog = (createdAt: number) => [{ did: DID, operation: {}, cid: 'x', nullified: false, createdAt: new Date(createdAt).toISOString() }, { did: DID, operation: {}, cid: 'y', nullified: false, createdAt: new Date(createdAt + 5 * DAY).toISOString() }]

function stubNetwork() {
  const base = globalThis.fetch
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('https://plc.directory/') || url.startsWith('https://public.api.bsky.app/')) {
        net.calls.push(url)
        if (url.startsWith('https://plc.directory/')) {
          if (net.plcThrows) throw new Error('network down')
          return new Response(typeof net.plc.body === 'string' ? net.plc.body : JSON.stringify(net.plc.body), { status: net.plc.status })
        }
        return new Response(JSON.stringify(net.profile.body), { status: net.profile.status })
      }
      return base(input, init)
    }),
  )
}

beforeEach(async () => {
  await resetState()
  clock = Date.now()
  oauth.states.clear()
  oauth.authorized.length = 0
  oauth.callbackParams.length = 0
  oauth.did = DID
  oauth.authorizeError = undefined
  oauth.callbackError = undefined
  net.plc = { status: 200, body: plcLog(clock - 40 * DAY) }
  net.plcThrows = false
  net.profile = { status: 200, body: { handle: 'alice.bsky.social', displayName: 'Alice', avatar: 'https://cdn.bsky.app/img/avatar/plain/did:plc:abc/x@jpeg' } }
  net.calls.length = 0
  stubNetwork()
  h = makeHarness({ now: () => clock, atproto: fakeAuth })
})

// ---- helpers -----------------------------------------------------------------------------------------------------------

const authorize = (body: unknown, headers: Record<string, string> = {}, hh: Harness = h) =>
  hh.fetch('/api/contrib/auth/bsky/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: SELF, 'CF-Connecting-IP': '203.0.113.5', ...headers },
    body: JSON.stringify(body),
  })

const cookieOf = (res: Response) => (res.headers.get('Set-Cookie') ?? '').split(';')[0]!

const callback = (state: string, cookie: string | null, extra = '') => h.fetch(`/api/contrib/auth/bsky/callback?state=${state}&code=c&iss=https%3A%2F%2Fbsky.social${extra}`, { headers: cookie ? { Cookie: cookie } : {} })

const dataOf = async (res: Response) => {
  const html = await res.text()
  return JSON.parse(html.match(/<script type="application\/json" id="d">([\s\S]*?)<\/script>/)![1]!)
}

/** authorize → callback with the matching cookie. */
async function signIn(handle = 'alice.bsky.social') {
  const a = await authorize({ handle, o: ORIGIN })
  expect(a.status, JSON.stringify(await a.clone().json())).toBe(200)
  const state = new URL((await json(a)).url).searchParams.get('request_uri')!
  return callback(state, cookieOf(a))
}

const count = async (table: string, where = '1=1') => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>())!.n

// ---- tests -------------------------------------------------------------------------------------------------------------

describe('handle normalisation', () => {
  it.each([
    ['alice.bsky.social', 'alice.bsky.social'],
    ['@Alice.BSKY.social', 'alice.bsky.social'],
    ['  at://alice.bsky.social  ', 'alice.bsky.social'],
    ['‪@alice.bsky.social‬', 'alice.bsky.social'],
    ['alice.example.com', 'alice.example.com'],
    [DID, DID],
    ['at://did:plc:ABCDEFGHIJKLMNOPQRSTUVWX', DID],
    ['did:web:example.com', 'did:web:example.com'],
    ['', null],
    ['   ', null],
    ['@', null],
    ['nodots', null],
    ['has space.bsky.social', null],
    ['a'.repeat(254), null],
    [`${'a'.repeat(64)}.bsky.social`, null],
    ['https://evil.example/x', null],
    [42, null],
    [null, null],
  ])('%j → %j', (input, expected) => {
    expect(normalizeHandleInput(input)).toBe(expected)
  })
})

describe('start page and chooser', () => {
  const start = (q: string, hh = h) => hh.fetch(`/api/contrib/auth/start?${q}`)

  it('two configured providers → chooser with both entries, links keep the origin', async () => {
    const res = await start(`o=${encodeURIComponent(ORIGIN)}`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Discord')
    expect(html).toContain('Bluesky')
    expect(html).toContain(`provider=discord&#38;o=${encodeURIComponent(ORIGIN)}`)
    expect(html).toContain(`provider=bluesky&#38;o=${encodeURIComponent(ORIGIN)}`)
    expect(html).not.toContain('form-action *')
  })

  it('an injected origin never reaches the page', async () => {
    const evil = `"><script>alert(1)</script>`
    const res = await start(`o=${encodeURIComponent(evil)}`)
    expect(res.status).toBe(400)
    expect(await res.text()).not.toContain('alert(1)')
  })

  it('exactly one configured provider → no chooser', async () => {
    const noDiscord = makeHarness({ now: () => clock, atproto: fakeAuth }, { DISCORD_CLIENT_ID: '', DISCORD_CLIENT_SECRET: '' })
    const onlyBsky = await (await start(`o=${encodeURIComponent(ORIGIN)}`, noDiscord)).text()
    expect(onlyBsky).toContain('id="h"')
    const noBsky = makeHarness({ now: () => clock }, { PUBLIC_URL: '' })
    const onlyDiscord = await (await start(`o=${encodeURIComponent(ORIGIN)}`, noBsky)).text()
    expect(onlyDiscord).toContain('Redirecting to Discord')
    const none = makeHarness({ now: () => clock }, { PUBLIC_URL: '', DISCORD_CLIENT_ID: '' })
    expect((await start(`o=${encodeURIComponent(ORIGIN)}`, none)).status).toBe(400)
  })

  it('provider bypasses the chooser; unknown provider and unknown origin are 400', async () => {
    const bsky = await start(`provider=bluesky&o=${encodeURIComponent(ORIGIN)}`)
    expect(bsky.status).toBe(200)
    const html = await bsky.text()
    expect(html).toContain('/api/contrib/auth/bsky/authorize')
    expect(html).toContain('id="h"')
    expect(bsky.headers.get('Content-Security-Policy')).toContain("form-action 'none'")
    expect(await dataOf(await start(`provider=bluesky&o=${encodeURIComponent(ORIGIN)}`))).toEqual({ origin: ORIGIN, r: null })
    expect((await start(`provider=discord&o=${encodeURIComponent(ORIGIN)}`)).status).toBe(200)
    expect((await start(`provider=reddit&o=${encodeURIComponent(ORIGIN)}`)).status).toBe(400)
    expect((await start(`provider=bluesky&o=${encodeURIComponent('https://evil.example')}`)).status).toBe(400)
  })

  it('lists configured providers', async () => {
    const res = await h.fetch('/api/contrib/auth/providers')
    expect((await json(res)).providers.map((p: { id: string }) => p.id)).toEqual(['discord', 'bluesky'])
  })
})

describe('client metadata', () => {
  it('is public JSON whose client_id is its own URL', async () => {
    const res = await h.fetch('/api/contrib/auth/bsky/client-metadata.json')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toMatch(/^application\/json/)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
    const doc = await json(res)
    expect(doc).toMatchObject({ scope: 'atproto', token_endpoint_auth_method: 'none', dpop_bound_access_tokens: true, application_type: 'web', response_types: ['code'] })
    expect(doc.grant_types).toContain('authorization_code')
    expect(doc.redirect_uris).toHaveLength(1)
  })

  it('the real client accepts both identities (hosted and loopback)', () => {
    const hosted = { ...env, PUBLIC_URL: 'https://cms.example.org' } as typeof env
    expect(createAtprotoClient(hosted).clientMetadata.client_id).toBe('https://cms.example.org/api/contrib/auth/bsky/client-metadata.json')
    const loopback = createAtprotoClient(env).clientMetadata
    expect(loopback.client_id.startsWith('http://localhost?redirect_uri=')).toBe(true)
    expect(loopback.redirect_uris).toEqual(['http://127.0.0.1:8787/api/contrib/auth/bsky/callback'])
  })
})

describe('POST /auth/bsky/authorize', () => {
  it.each([
    ['@Alice.BSKY.social', 'alice.bsky.social'],
    ['at://alice.bsky.social', 'alice.bsky.social'],
    ['  alice.example.com ', 'alice.example.com'],
    [DID, DID],
  ])('normalises %j → %s and returns the authorization URL with a flow cookie', async (input, expected) => {
    const res = await authorize({ handle: input, o: ORIGIN })
    expect(res.status).toBe(200)
    expect((await json(res)).url).toMatch(/^https:\/\/bsky\.social\/oauth\/authorize\?/)
    expect(oauth.authorized).toHaveLength(1)
    expect(oauth.authorized[0]!.handle).toBe(expected)
    expect(oauth.authorized[0]!.state.o).toBe(ORIGIN)
    const cookie = res.headers.get('Set-Cookie')!
    expect(cookie).toContain(`cms_bsky_flow=${oauth.authorized[0]!.state.nonce}`)
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
    expect(cookie).toContain('Path=/api/contrib/auth/bsky')
    expect(cookie).toContain('Max-Age=600')
  })

  it.each([[''], ['   '], ['nodots'], ['a'.repeat(300)], [undefined], [42]])('rejects handle %j before calling the library', async (handle) => {
    const res = await authorize({ handle, o: ORIGIN })
    expect(res.status).toBe(400)
    expect((await json(res)).error.code).toBe('handle_unresolved')
    expect(oauth.authorized).toHaveLength(0)
    expect(res.headers.get('Set-Cookie')).toBeNull()
  })

  it('did:web is refused up front, without any network call', async () => {
    net.calls.length = 0
    const res = await authorize({ handle: 'did:web:example.com', o: ORIGIN })
    expect(res.status).toBe(400)
    expect((await json(res)).error.code).toBe('unsupported_did')
    expect(oauth.authorized).toHaveLength(0)
    expect(net.calls).toEqual([])
  })

  it('rejects origins outside the allow-list, cross-site callers and bad bodies', async () => {
    expect((await authorize({ handle: 'alice.bsky.social', o: 'https://evil.example' })).status).toBe(400)
    expect((await authorize({ handle: 'alice.bsky.social' })).status).toBe(400)
    expect((await authorize({ handle: 'alice.bsky.social', o: ORIGIN }, { Origin: 'https://evil.example' })).status).toBe(403)
    // local development: the loopback client makes the popup run on 127.0.0.1
    expect((await authorize({ handle: 'alice.bsky.social', o: ORIGIN }, { Origin: 'http://127.0.0.1:8787' })).status).toBe(200)
    expect((await authorize({ handle: 'alice.bsky.social', o: ORIGIN }, { Origin: 'http://127.0.0.1:9999' })).status).toBe(403)
    const hosted = makeHarness({ now: () => clock, atproto: fakeAuth }, { PUBLIC_URL: 'https://cms.example.org' })
    expect((await authorize({ handle: 'alice.bsky.social', o: ORIGIN }, { Origin: 'http://127.0.0.1:8787' }, hosted)).status).toBe(403)
    expect((await authorize({ handle: 'alice.bsky.social', o: ORIGIN }, { Origin: 'https://cms.example.org' }, hosted)).status).toBe(200)
    oauth.authorized.length = 0
    const noOrigin = await h.fetch('/api/contrib/auth/bsky/authorize', { method: 'POST', body: JSON.stringify({ handle: 'a.bsky.social', o: ORIGIN }) })
    expect(noOrigin.status).toBe(403)
    const bad = await h.fetch('/api/contrib/auth/bsky/authorize', { method: 'POST', headers: { Origin: SELF }, body: '{nope' })
    expect(bad.status).toBe(400)
    expect(oauth.authorized).toHaveLength(0)
  })

  it('is rate limited per client', async () => {
    const limited = makeHarness({ now: () => clock, atproto: fakeAuth }, { AUTH_LIMITER: { limit: async () => ({ success: false }) } })
    const res = await authorize({ handle: 'alice.bsky.social', o: ORIGIN }, {}, limited)
    expect(res.status).toBe(429)
    expect(oauth.authorized).toHaveLength(0)
  })

  it('maps library errors to friendly codes and never leaks the raw message', async () => {
    for (const [err, status, code] of [
      [new AtprotoError('handle_unresolved', { cause: new Error('secret internal detail') }), 400, 'handle_unresolved'],
      [new AtprotoError('unsupported_did'), 400, 'unsupported_did'],
      [new AtprotoError('unavailable'), 502, 'unavailable'],
      [new Error('ECONNRESET to 10.0.0.1'), 502, 'unavailable'],
    ] as const) {
      oauth.authorizeError = err
      const res = await authorize({ handle: 'alice.bsky.social', o: ORIGIN })
      expect(res.status).toBe(status)
      const body = await res.text()
      expect(JSON.parse(body).error.code).toBe(code)
      expect(body).not.toMatch(/secret internal|ECONNRESET|10\.0\.0\.1/)
      expect(res.headers.get('Set-Cookie')).toBeNull()
    }
  })
})

describe('callback: account age gate', () => {
  it(`rejects a ${CONTRIB_MIN_ACCOUNT_AGE_DAYS - 1}-day-old account and leaves nothing behind`, async () => {
    net.plc.body = plcLog(clock - 29 * DAY)
    const res = await signIn()
    expect(res.status).toBe(400)
    const d = await dataOf(res)
    expect(d.msg.code).toBe('account_too_young')
    expect(d.msg.eligibleAt).toBeGreaterThan(clock)
    expect(d.msg.token).toBeUndefined()
    expect(await count('user_tab')).toBe(0)
    expect(await count('account_tab')).toBe(0)
    expect(await count('contributor_tab')).toBe(0)
    expect(await count('contrib_token_tab')).toBe(0)
  })

  it('accepts a 31-day-old account: user, account, contributor (handle), audit and a working token', async () => {
    net.plc.body = plcLog(clock - 31 * DAY)
    const res = await signIn()
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
    const d = await dataOf(res)
    expect(d.origin).toBe(ORIGIN)
    expect(d.msg).toMatchObject({ type: 'cms-contrib', user: { displayName: 'Alice', image: 'https://cdn.bsky.app/img/avatar/plain/did:plc:abc/x@jpeg' } })
    const me = await json(await contribApi(h, d.msg.token, 'GET', '/me'))
    expect(me.user).toEqual(d.msg.user)
    const row = (await env.DB.prepare('SELECT * FROM contributor_tab').first<Record<string, unknown>>())!
    expect(row).toMatchObject({ user_id: d.msg.user.id, display_name: 'Alice', handle: 'alice.bsky.social' })
    const acct = (await env.DB.prepare('SELECT * FROM account_tab').first<Record<string, unknown>>())!
    expect(acct).toMatchObject({ provider_id: 'bluesky', account_id: DID, user_id: d.msg.user.id, access_token: null, refresh_token: null, id_token: null })
    const user = (await env.DB.prepare('SELECT email FROM user_tab').first<{ email: string }>())!
    expect(user.email).toMatch(/^bluesky-[0-9a-f]{32}@users\.invalid$/)
    expect(user.email).not.toContain(DID.slice(8))
    expect(await count('audit_log_tab', "action = 'contrib.create'")).toBe(1)
  })

  it.each([
    ['500', () => (net.plc = { status: 500, body: 'oops' })],
    ['404', () => (net.plc = { status: 404, body: 'nope' })],
    ['network error', () => (net.plcThrows = true)],
    ['not JSON', () => (net.plc = { status: 200, body: '<html>' })],
    ['empty log', () => (net.plc = { status: 200, body: [] })],
    ['not an array', () => (net.plc = { status: 200, body: { createdAt: new Date(0).toISOString() } })],
    ['entry without createdAt', () => (net.plc = { status: 200, body: [{ did: DID }] })],
    ['unparsable createdAt', () => (net.plc = { status: 200, body: [{ createdAt: 'yesterday' }] })],
  ])('PLC %s → age_check_unavailable (fail closed), nothing written', async (_name, arrange) => {
    arrange()
    const res = await signIn()
    expect(res.status).toBe(400)
    const d = await dataOf(res)
    expect(d.msg).toEqual({ type: 'cms-contrib-error', code: 'age_check_unavailable' })
    expect(await count('user_tab')).toBe(0)
    expect(await count('contributor_tab')).toBe(0)
    expect(await count('contrib_token_tab')).toBe(0)
  })

  it('uses the earliest operation, whatever the log order', async () => {
    net.plc.body = [...plcLog(clock - 31 * DAY)].reverse()
    expect((await signIn()).status).toBe(200)
  })

  it('a did:web that somehow comes back from the library is refused before any lookup', async () => {
    oauth.did = 'did:web:example.com'
    const res = await signIn()
    expect(res.status).toBe(400)
    expect((await dataOf(res)).msg.code).toBe('unauthenticated')
    expect(net.calls).toEqual([])
    expect(await count('user_tab')).toBe(0)
  })
})

describe('callback: returning contributor', () => {
  it('mints a token without an age check or new rows', async () => {
    expect((await signIn()).status).toBe(200)
    const before = [await count('user_tab'), await count('account_tab'), await count('contributor_tab'), await count('audit_log_tab', "action = 'contrib.create'")]
    net.calls.length = 0
    net.plc = { status: 500, body: 'down' } // would fail a check
    clock += 2 * DAY
    const res = await signIn()
    expect(res.status).toBe(200)
    const d = await dataOf(res)
    expect(d.msg.type).toBe('cms-contrib')
    expect((await json(await contribApi(h, d.msg.token, 'GET', '/me'))).user.displayName).toBe('Alice')
    expect(net.calls).toEqual([])
    expect([await count('user_tab'), await count('account_tab'), await count('contributor_tab'), await count('audit_log_tab', "action = 'contrib.create'")]).toEqual(before)
    expect(await count('contrib_token_tab')).toBe(2)
  })

  it('a contributor who is young now is not re-checked', async () => {
    expect((await signIn()).status).toBe(200)
    net.plc.body = plcLog(clock - 1 * DAY)
    expect((await signIn()).status).toBe(200)
  })

  it('keeps the stored handle and name even when the profile changed', async () => {
    expect((await signIn()).status).toBe(200)
    net.profile.body = { handle: 'renamed.bsky.social', displayName: 'Someone Else' }
    const d = await dataOf(await signIn())
    expect(d.msg.user.displayName).toBe('Alice')
    expect((await env.DB.prepare('SELECT handle FROM contributor_tab').first<{ handle: string }>())!.handle).toBe('alice.bsky.social')
  })

  it('a user whose contributor row was pruned goes through the age gate again', async () => {
    expect((await signIn()).status).toBe(200)
    await env.DB.prepare('DELETE FROM contributor_tab').run()
    net.plc.body = plcLog(clock - 2 * DAY)
    expect((await dataOf(await signIn())).msg.code).toBe('account_too_young')
    net.plc.body = plcLog(clock - 40 * DAY)
    expect((await signIn()).status).toBe(200)
    expect(await count('user_tab')).toBe(1)
    expect(await count('contributor_tab')).toBe(1)
  })
})

describe('callback: flow security', () => {
  it('needs the flow cookie; a different nonce, no cookie or an unknown state gives an error and no token', async () => {
    const a = await authorize({ handle: 'alice.bsky.social', o: ORIGIN })
    const state = new URL((await json(a)).url).searchParams.get('request_uri')!
    for (const cookie of [null, 'cms_bsky_flow=not-the-nonce', 'other=1']) {
      const res = await callback(state, cookie)
      expect(res.status).toBe(400)
      expect(await res.text()).not.toContain('cct_')
    }
    expect((await callback('state-unknown', cookieOf(a))).status).toBe(400)
    expect((await callback('', cookieOf(a))).status).toBe(400)
    expect(oauth.callbackParams).toHaveLength(0) // the library never saw the code
    expect(await count('contrib_token_tab')).toBe(0)
    expect(await count('user_tab')).toBe(0)
    // ... and the legitimate browser can still finish afterwards.
    expect((await callback(state, cookieOf(a))).status).toBe(200)
  })

  it('clears the flow cookie after use, and a second use of the same state fails', async () => {
    const a = await authorize({ handle: 'alice.bsky.social', o: ORIGIN })
    const state = new URL((await json(a)).url).searchParams.get('request_uri')!
    const ok = await callback(state, cookieOf(a))
    expect(ok.status).toBe(200)
    expect(ok.headers.get('Set-Cookie')).toMatch(/cms_bsky_flow=;/)
    expect(ok.headers.get('Set-Cookie')).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i)
    expect((await callback(state, cookieOf(a))).status).toBe(400)
  })

  it('refuses a flow whose origin is no longer allowed', async () => {
    oauth.states.set('state-evil', { o: 'https://evil.example', nonce: 'n0nce' })
    const res = await callback('state-evil', 'cms_bsky_flow=n0nce')
    expect(res.status).toBe(400)
    expect(await res.text()).not.toContain('postMessage(d.msg,d.origin);')
    expect(oauth.callbackParams).toHaveLength(0)
  })

  it('the user denying access, or a failing code exchange, ends as unauthenticated', async () => {
    const a = await authorize({ handle: 'alice.bsky.social', o: ORIGIN })
    const state = new URL((await json(a)).url).searchParams.get('request_uri')!
    const denied = await callback(state, cookieOf(a), '&error=access_denied&error_description=nope')
    expect(denied.status).toBe(400)
    const d = await dataOf(denied)
    expect(d.msg).toEqual({ type: 'cms-contrib-error', code: 'unauthenticated' })
    expect(JSON.stringify(d)).not.toContain('nope')

    const b = await authorize({ handle: 'alice.bsky.social', o: ORIGIN })
    const state2 = new URL((await json(b)).url).searchParams.get('request_uri')!
    oauth.callbackError = new AtprotoError('callback_failed', { cause: new Error('invalid_grant: secret detail') })
    const failed = await callback(state2, cookieOf(b))
    expect(failed.status).toBe(400)
    const text = await failed.text()
    expect(text).not.toContain('secret detail')
    expect(text).toContain('unauthenticated')
    expect(await count('user_tab')).toBe(0)
  })

  it('the popup result is only posted to the wiki origin', async () => {
    const res = await signIn()
    const html = await res.text()
    expect(html).toContain('postMessage(d.msg,d.origin)')
    expect(html).not.toContain("postMessage(d.msg,'*')")
  })
})

describe('hand-back by polling (the provider page severed window.opener)', () => {
  const R = 'abcdefghijklmnopqrstuvwxyz012345'
  const poll = (body: unknown, origin = ORIGIN) =>
    h.fetch('/api/contrib/auth/poll', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) })

  async function signInWith(r?: string) {
    const a = await authorize({ handle: 'alice.bsky.social', o: ORIGIN, ...(r ? { r } : {}) })
    expect(a.status).toBe(200)
    const state = new URL((await json(a)).url).searchParams.get('request_uri')!
    return callback(state, cookieOf(a))
  }

  it('carries r through the OAuth state and deposits the result for the tab', async () => {
    const res = await signInWith(R)
    expect(res.status).toBe(200)
    const d = await dataOf(res)
    expect(d.polled).toBe(true)
    const got = await poll({ r: R })
    expect(got.status).toBe(200)
    expect(got.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
    const body = await json(got)
    expect(body.message).toEqual(d.msg)
    expect(body.message.type).toBe('cms-contrib')
    // single use
    expect(await json(await poll({ r: R }))).toEqual({ pending: true })
  })

  it('is pending before the sign-in finishes, and for another secret', async () => {
    expect(await json(await poll({ r: R }))).toEqual({ pending: true })
    await signInWith(R)
    expect(await json(await poll({ r: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' }))).toEqual({ pending: true })
  })

  it('is only handed to the origin that started the flow, and does not consume for another origin', async () => {
    await signInWith(R)
    const other = await poll({ r: R }, 'https://evil.example')
    expect(other.status).toBe(403)
    expect(await json(await poll({ r: R, }))).toMatchObject({ message: { type: 'cms-contrib' } })
  })

  it('also delivers errors (a too-young account)', async () => {
    net.plc = { status: 200, body: plcLog(clock - 2 * DAY) }
    expect((await signInWith(R)).status).toBe(400)
    expect(await json(await poll({ r: R }))).toMatchObject({ message: { type: 'cms-contrib-error', code: 'account_too_young' } })
  })

  it('without r nothing is deposited and the popup keeps the opener-only fallback', async () => {
    const res = await signInWith()
    const d = await dataOf(res)
    expect(d.polled).toBe(false)
    expect(await count('oauth_state_tab', "key LIKE 'login-result:%'")).toBe(0)
  })

  it('rejects a malformed secret', async () => {
    expect((await poll({ r: 'short' })).status).toBe(400)
    expect((await poll({})).status).toBe(400)
    const a = await authorize({ handle: 'alice.bsky.social', o: ORIGIN, r: 'bad value!' })
    const state = new URL((await json(a)).url).searchParams.get('request_uri')!
    expect(await dataOf(await callback(state, cookieOf(a)))).toMatchObject({ polled: false })
  })

  it('housekeeping-eligible: the deposit expires', async () => {
    await signInWith(R)
    clock += 6 * 60 * 1000
    expect(await json(await poll({ r: R }))).toEqual({ pending: true })
  })
})

describe('profile', () => {
  const profileOf = async () => ({
    contributor: (await env.DB.prepare('SELECT display_name, handle FROM contributor_tab').first<{ display_name: string; handle: string | null }>())!,
    image: (await env.DB.prepare('SELECT image FROM user_tab').first<{ image: string | null }>())!.image,
  })

  it('empty displayName → the first label of the handle', async () => {
    net.profile.body = { handle: 'carol.example.com', displayName: '' }
    expect((await signIn()).status).toBe(200)
    expect((await profileOf()).contributor).toEqual({ display_name: 'carol', handle: 'carol.example.com' })
  })

  it('handle.invalid → null handle, and the name falls back to Contributor', async () => {
    net.profile.body = { handle: 'handle.invalid' }
    expect((await signIn()).status).toBe(200)
    expect((await profileOf()).contributor).toEqual({ display_name: 'Contributor', handle: null })
  })

  it.each([
    ['500', () => (net.profile = { status: 500, body: 'x' })],
    ['garbage', () => (net.profile = { status: 200, body: 'not an object' })],
  ])('getProfile %s → defaults, sign-in still succeeds', async (_n, arrange) => {
    arrange()
    const res = await signIn()
    expect(res.status).toBe(200)
    expect(await profileOf()).toEqual({ contributor: { display_name: 'Contributor', handle: null }, image: null })
  })

  it('an avatar outside Bluesky’s CDN is dropped; a control-character name is normalised', async () => {
    net.profile.body = { handle: 'alice.bsky.social', displayName: '  Al\u0000ice‮  ', avatar: 'https://evil.example/a.png' }
    expect((await signIn()).status).toBe(200)
    const p = await profileOf()
    expect(p.image).toBeNull()
    expect(p.contributor.display_name).toBe('Alice')
  })
})

describe('moderator boundary', () => {
  it('a Bluesky contributor has no BetterAuth session and cannot reach /api/admin', async () => {
    const d = await dataOf(await signIn())
    const token: string = d.msg.token
    expect(await count('session_tab')).toBe(0)
    expect(await count('moderator_permission_tab')).toBe(0)
    for (const [method, path] of [
      ['GET', '/api/admin/me'],
      ['POST', '/api/admin/invites/claim'],
    ] as const) {
      const res = await h.fetch(path, { method, headers: { Authorization: `Bearer ${token}`, Origin: SELF, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) })
      expect(res.status, path).toBe(401)
    }
    // the same user id as a cookie-less caller
    expect((await h.fetch('/api/admin/me', { headers: { Origin: SELF } })).status).toBe(401)
  })
})

describe('stores', () => {
  it('state store: a DPoP key survives the JSON round trip and the TTL is honoured', async () => {
    const store = d1StateStore(env, () => clock)
    const key = await JoseKey.generate(['ES256'])
    await store.set('k1', { iss: 'https://bsky.social', dpopKey: key, authMethod: { method: 'none' }, verifier: 'v', appState: JSON.stringify({ o: ORIGIN, nonce: 'n' }) })
    const raw = (await env.DB.prepare('SELECT value, expires_at FROM oauth_state_tab WHERE key = ?').bind('k1').first<{ value: string; expires_at: number }>())!
    expect(raw.expires_at).toBe(clock + BSKY_STATE_TTL_MS)
    expect(JSON.parse(raw.value).dpopKey.d).toBeTruthy() // stored as the private JWK
    const got = (await store.get('k1'))!
    expect(got).toMatchObject({ iss: 'https://bsky.social', verifier: 'v', authMethod: { method: 'none' } })
    expect(got.dpopKey.privateJwk).toEqual(key.privateJwk)
    // the restored key still signs
    expect(await got.dpopKey.createJwt({ alg: 'ES256' }, { sub: 'x' })).toMatch(/^eyJ/)
    expect(await store.get('missing')).toBeUndefined()
    clock += BSKY_STATE_TTL_MS + 1
    expect(await store.get('k1')).toBeUndefined()
    await store.del('k1')
    expect(await count('oauth_state_tab')).toBe(0)
  })

  it('housekeeping deletes expired state rows only', async () => {
    await env.DB.prepare('INSERT INTO oauth_state_tab (key,value,expires_at) VALUES (?,?,?), (?,?,?)').bind('old', '{}', clock - 1, 'live', '{}', clock + 1000).run()
    const r = await runHousekeeping(env, h.purge, clock)
    expect(r.oauthStatesDeleted).toBe(1)
    expect((await env.DB.prepare('SELECT key FROM oauth_state_tab').all<{ key: string }>()).results.map((x) => x.key)).toEqual(['live'])
  })
})

describe('moderator tools', () => {
  it('shows the Bluesky handle to moderators only (never in a public response)', async () => {
    const d = await dataOf(await signIn())
    const cookie = await sessionCookie('mod', { types: [TYPE] })
    const admin = (path: string) => h.fetch(`/api/admin${path}`, { headers: { Cookie: cookie, Origin: SELF } })
    const found = await json(await admin('/contributors?q=alice.bsky'))
    expect(found.contributors).toHaveLength(1)
    expect(found.contributors[0]).toMatchObject({ id: d.msg.user.id, provider: 'bluesky', accountId: DID, handle: 'alice.bsky.social' })
    expect((await json(await admin('/contributors?q=Alice'))).contributors).toHaveLength(1)
    expect((await json(await admin(`/contributors?q=${encodeURIComponent(DID)}`))).contributors).toHaveLength(1)
    // never in what the contributor / public APIs return
    const me = await contribApi(h, d.msg.token, 'GET', '/me')
    expect(await me.text()).not.toContain('alice.bsky.social')
  })
})
