import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AtprotoError, createAtprotoAuth } from '../src/core/atproto.ts'
import { ORIGIN, resetState } from './helpers.ts'

// The real @atproto/oauth-client inside workerd, against a fake handle resolver / PLC directory / PDS / authorization server.
// Covers the pieces a unit test can: handle → DID → did:plc document, PAR with DPoP, the D1 state store, the callback code exchange,
// revoke, and the two `redirect: 'error'` workarounds. The real round trip with bsky.social stays a deploy step (see the plan).

const DID = 'did:plc:abcdefghijklmnopqrstuvwx'
const PDS = 'https://pds.example.test'
const AS = 'https://auth.example.test'
const hostedEnv = { ...env, PUBLIC_URL: 'https://cms.example.org' } as typeof env

interface Seen {
  url: string
  method: string
  headers: Headers
  body: URLSearchParams | null
}
let seen: Seen[]
let behave: { resolveHandle: 'ok' | 'did-web' | 'unknown' | 'redirect'; plcDocRedirect: boolean; tokenSub: string }

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...init.headers } })

function didDoc(did: string, handle = 'alice.bsky.social') {
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: did,
    alsoKnownAs: [`at://${handle}`],
    verificationMethod: [],
    service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }],
  }
}

beforeEach(async () => {
  await resetState()
  seen = []
  behave = { resolveHandle: 'ok', plcDocRedirect: false, tokenSub: DID }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init)
      const url = new URL(req.url)
      const body = req.method === 'POST' ? new URLSearchParams(await req.clone().text()) : null
      seen.push({ url: req.url, method: req.method, headers: req.headers, body })
      const at = (u: string) => req.url === u || req.url.startsWith(u + '?')
      if (url.origin === 'https://public.api.bsky.app' && url.pathname === '/xrpc/com.atproto.identity.resolveHandle') {
        if (behave.resolveHandle === 'unknown') return json({ error: 'InvalidRequest', message: 'Unable to resolve handle' }, { status: 400 })
        if (behave.resolveHandle === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })
        return json({ did: behave.resolveHandle === 'did-web' ? 'did:web:alice.example.com' : DID })
      }
      if (at(`https://plc.directory/${DID}`)) {
        if (behave.plcDocRedirect) return new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })
        return json(didDoc(DID), { headers: { 'content-type': 'application/did+ld+json' } })
      }
      if (at(`${PDS}/.well-known/oauth-protected-resource`)) return json({ resource: PDS, authorization_servers: [AS] })
      if (at(`${AS}/.well-known/oauth-authorization-server`)) {
        return json({
          issuer: AS,
          authorization_endpoint: `${AS}/oauth/authorize`,
          token_endpoint: `${AS}/oauth/token`,
          revocation_endpoint: `${AS}/oauth/revoke`,
          pushed_authorization_request_endpoint: `${AS}/oauth/par`,
          require_pushed_authorization_requests: true,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
          token_endpoint_auth_signing_alg_values_supported: ['ES256'],
          scopes_supported: ['atproto'],
          authorization_response_iss_parameter_supported: true,
          dpop_signing_alg_values_supported: ['ES256'],
          client_id_metadata_document_supported: true,
        })
      }
      if (at(`${AS}/oauth/par`)) return json({ request_uri: 'urn:ietf:params:oauth:request_uri:req-123', expires_in: 60 }, { status: 201 })
      if (at(`${AS}/oauth/token`)) return json({ access_token: 'at-secret', token_type: 'DPoP', expires_in: 300, refresh_token: 'rt-secret', scope: 'atproto', sub: behave.tokenSub })
      if (at(`${AS}/oauth/revoke`)) return new Response(null, { status: 200 })
      return new Response('not found: ' + req.url, { status: 404 })
    }),
  )
})

const to = (u: string) => seen.filter((s) => s.url.startsWith(u))

describe('real OAuth client in workerd', () => {
  it('authorize: handle → DID → PDS → authorization server → PAR (DPoP) → authorization URL', async () => {
    const auth = createAtprotoAuth(hostedEnv)
    const url = new URL(await auth.authorize('alice.bsky.social', { o: ORIGIN, nonce: 'n0nce' }))
    expect(url.origin + url.pathname).toBe(`${AS}/oauth/authorize`)
    expect(url.searchParams.get('client_id')).toBe('https://cms.example.org/api/contrib/auth/bsky/client-metadata.json')
    expect(url.searchParams.get('request_uri')).toBe('urn:ietf:params:oauth:request_uri:req-123')

    const par = to(`${AS}/oauth/par`)[0]!
    expect(par.headers.get('DPoP')).toMatch(/^eyJ/)
    expect(par.body!.get('scope')).toBe('atproto')
    expect(par.body!.get('redirect_uri')).toBe('https://cms.example.org/api/contrib/auth/bsky/callback')
    expect(par.body!.get('code_challenge_method')).toBe('S256')
    expect(par.body!.get('login_hint')).toBe('alice.bsky.social')
    expect(par.body!.get('client_secret')).toBeNull()
    // no other host was contacted
    for (const s of seen) expect(['https://public.api.bsky.app', 'https://plc.directory', PDS, AS]).toContain(new URL(s.url).origin)
    // the pending request is in D1 and can be peeked without being consumed
    const state = par.body!.get('state')!
    expect(await auth.peekState(state)).toEqual({ o: ORIGIN, nonce: 'n0nce' })
    expect(await auth.peekState(state)).toEqual({ o: ORIGIN, nonce: 'n0nce' })
    expect(await auth.peekState('unknown')).toBeNull()
  })

  it('callback: exchanges the code with DPoP, returns the DID, revokes the session and consumes the state', async () => {
    const auth = createAtprotoAuth(hostedEnv)
    await auth.authorize('alice.bsky.social', { o: ORIGIN, nonce: 'n0nce' })
    const par = to(`${AS}/oauth/par`)[0]!
    const state = par.body!.get('state')!
    // a fresh client (as in the callback request) finishes the flow from D1 alone
    const callbackAuth = createAtprotoAuth(hostedEnv)
    const { did } = await callbackAuth.callback(new URLSearchParams({ state, code: 'the-code', iss: AS }))
    expect(did).toBe(DID)

    const token = to(`${AS}/oauth/token`)[0]!
    expect(token.body!.get('grant_type')).toBe('authorization_code')
    expect(token.body!.get('code')).toBe('the-code')
    expect(token.body!.get('code_verifier')).toBeTruthy()
    expect(token.headers.get('DPoP')).toMatch(/^eyJ/)
    const revoke = to(`${AS}/oauth/revoke`)
    expect(revoke).toHaveLength(1)
    expect(revoke[0]!.body!.get('token')).toBeTruthy()
    expect(await callbackAuth.peekState(state)).toBeNull()
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_state_tab').first<{ n: number }>())!.n).toBe(0)
    // nothing token-like is persisted anywhere in D1
    for (const t of ['account_tab', 'oauth_state_tab', 'user_tab', 'contributor_tab', 'verification_tab']) {
      const dump = JSON.stringify((await env.DB.prepare(`SELECT * FROM ${t}`).all()).results)
      expect(dump, t).not.toMatch(/at-secret|rt-secret/)
    }
  })

  it('callback: a state that is unknown, replayed or mismatched fails with callback_failed', async () => {
    const auth = createAtprotoAuth(hostedEnv)
    await expect(auth.callback(new URLSearchParams({ state: 'nope', code: 'c', iss: AS }))).rejects.toMatchObject({ code: 'callback_failed' })
    await auth.authorize('alice.bsky.social', { o: ORIGIN, nonce: 'n' })
    const state = to(`${AS}/oauth/par`)[0]!.body!.get('state')!
    await expect(auth.callback(new URLSearchParams({ state, code: 'c', iss: 'https://other.example' }))).rejects.toBeInstanceOf(AtprotoError)
  })

  it('callback: a token response for a different subject is rejected', async () => {
    const auth = createAtprotoAuth(hostedEnv)
    await auth.authorize('alice.bsky.social', { o: ORIGIN, nonce: 'n' })
    const state = to(`${AS}/oauth/par`)[0]!.body!.get('state')!
    behave.tokenSub = 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz'
    await expect(auth.callback(new URLSearchParams({ state, code: 'c', iss: AS }))).rejects.toMatchObject({ code: 'callback_failed' })
  })

  it('authorize with a DID goes straight to the PLC directory', async () => {
    const auth = createAtprotoAuth(hostedEnv)
    await auth.authorize(DID, { o: ORIGIN, nonce: 'n' })
    expect(to(`https://plc.directory/${DID}`).length).toBeGreaterThan(0)
  })

  it('a handle that resolves to did:web is refused as unsupported_did (no did:web fetch)', async () => {
    behave.resolveHandle = 'did-web'
    await expect(createAtprotoAuth(hostedEnv).authorize('alice.example.com', { o: ORIGIN, nonce: 'n' })).rejects.toMatchObject({ code: 'unsupported_did' })
    expect(seen.some((s) => s.url.includes('example.com/.well-known/did.json'))).toBe(false)
  })

  it('an unknown handle is handle_unresolved', async () => {
    behave.resolveHandle = 'unknown'
    await expect(createAtprotoAuth(hostedEnv).authorize('nobody.bsky.social', { o: ORIGIN, nonce: 'n' })).rejects.toMatchObject({ code: 'handle_unresolved' })
  })

  it('redirects from the resolver or the PLC directory are failures, not followed', async () => {
    behave.resolveHandle = 'redirect'
    await expect(createAtprotoAuth(hostedEnv).authorize('alice.bsky.social', { o: ORIGIN, nonce: 'n' })).rejects.toBeInstanceOf(AtprotoError)
    behave.resolveHandle = 'ok'
    behave.plcDocRedirect = true
    await expect(createAtprotoAuth(hostedEnv).authorize('alice.bsky.social', { o: ORIGIN, nonce: 'n' })).rejects.toBeInstanceOf(AtprotoError)
    expect(seen.some((s) => s.url.startsWith('https://evil.example'))).toBe(false)
  })

  it('works with the loopback client used in local development', async () => {
    const url = new URL(await createAtprotoAuth(env).authorize('alice.bsky.social', { o: ORIGIN, nonce: 'n' }))
    expect(url.searchParams.get('client_id')).toMatch(/^http:\/\/localhost\?redirect_uri=/)
    const par = to(`${AS}/oauth/par`)[0]!
    expect(par.body!.get('redirect_uri')).toBe('http://127.0.0.1:8787/api/contrib/auth/bsky/callback')
  })
})
