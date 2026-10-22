import { DidError, didDocumentValidator } from '@atproto/did'
import { JoseKey } from '@atproto/jwk-jose'
import { OAuthClient, type InternalStateData, type OAuthClientOptions, type SessionStore, type StateStore } from '@atproto/oauth-client'
import { and, eq, gt } from 'drizzle-orm'
import { BSKY_CLIENT_NAME, BSKY_STATE_TTL_MS } from '../config.ts'
import type { Env } from '../env.ts'
import { PLC_DID_RE } from './bluesky.ts'
import { getDb } from './db/client.ts'
import { oauth_state_tab } from './db/schema.ts'

// The only module that imports @atproto/*. Bluesky sign-in bypasses BetterAuth (it cannot do DPoP / PAR / discoverable client
// ids): scope is `atproto` only, we read the user's DID and revoke the OAuth session immediately. See docs/ARCHITECTURE.md.

export type AtprotoErrorCode = 'handle_unresolved' | 'unsupported_did' | 'unavailable' | 'callback_failed'

export class AtprotoError extends Error {
  readonly code: AtprotoErrorCode
  constructor(code: AtprotoErrorCode, options?: { cause?: unknown }) {
    super(code, options)
    this.name = 'AtprotoError'
    this.code = code
  }
}

/** What travels through the authorization request (JSON in the library's `appState`). */
export interface FlowState {
  /** Wiki origin that opened the popup. */
  o: string
  /** Random value also held in the flow cookie: binds the callback to the browser that started the flow. */
  nonce: string
  /** The wiki tab's hand-back secret (see `LOGIN_RESULT_ID_RE`); absent for an embed that predates it. */
  r?: string
}

/** What the sign-in routes need from the OAuth client. Tests inject a fake through `Deps.atproto`. */
export interface AtprotoAuth {
  /** Authorization URL to send the popup to. Throws AtprotoError. */
  authorize(handleOrDid: string, state: FlowState): Promise<string>
  /** The still-valid pending request for `?state=`, without consuming it. */
  peekState(stateKey: string): Promise<FlowState | null>
  /** Finishes the flow and returns the verified DID; the OAuth session is revoked before this returns. Throws AtprotoError. */
  callback(params: URLSearchParams): Promise<{ did: string }>
}

export type AtprotoAuthFactory = (env: Env) => AtprotoAuth

// ---- client identity ---------------------------------------------------------------------------------------------------

const CALLBACK_PATH = '/api/contrib/auth/bsky/callback'
export const CLIENT_METADATA_PATH = '/api/contrib/auth/bsky/client-metadata.json'
const SCOPE = 'atproto'

const baseUrl = (env: Env) => env.PUBLIC_URL.replace(/\/+$/, '')

/** Local development: atproto's loopback client (no hosted metadata document). The popup must then be opened on 127.0.0.1. */
function loopbackPort(env: Env): string | null {
  try {
    const u = new URL(env.PUBLIC_URL)
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' ? u.port || '80' : null
  } catch {
    return null
  }
}

export function clientIdentity(env: Env): { clientId: string; redirectUri: string; loopback: boolean } {
  const port = loopbackPort(env)
  if (port) {
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`
    return { clientId: `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPE)}`, redirectUri, loopback: true }
  }
  return { clientId: `${baseUrl(env)}${CLIENT_METADATA_PATH}`, redirectUri: `${baseUrl(env)}${CALLBACK_PATH}`, loopback: false }
}

/** Origins the popup's own script may call the Worker from: `PUBLIC_URL`, plus 127.0.0.1 in local development (the loopback client needs it). */
export function selfOrigins(env: Env): string[] {
  const out = [new URL(env.PUBLIC_URL).origin]
  const port = loopbackPort(env)
  if (port) out.push(new URL(clientIdentity(env).redirectUri).origin)
  return out
}

/** The hosted client metadata document Bluesky's authorization server fetches (served at `client_id`). */
export function clientMetadataDocument(env: Env) {
  const { clientId, redirectUri } = clientIdentity(env)
  return {
    client_id: clientId,
    client_name: BSKY_CLIENT_NAME,
    client_uri: baseUrl(env),
    redirect_uris: [redirectUri],
    scope: SCOPE,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'web',
    dpop_bound_access_tokens: true,
  }
}

// ---- workerd workarounds -----------------------------------------------------------------------------------------------
// workerd throws on `redirect: 'error'` (before any custom fetch runs when the library builds a Request with it). Two places
// need help; neither requires patching the library. Remove these if upstream stops using `redirect: 'error'`.

/** Maps `redirect: 'error'` to `'manual'` and fails on a 3xx answer, which is what 'error' means. */
const workerdFetch: typeof fetch = async (input, init) => {
  if (init?.redirect !== 'error') return fetch(input, init)
  const res = await fetch(input, { ...init, redirect: 'manual' })
  if (res.status >= 300 && res.status < 400) {
    res.body?.cancel()
    throw new TypeError(`Unexpected redirect (${res.status})`)
  }
  return res
}

const UNSUPPORTED_DID_METHOD = 'unsupported-did-method'
const DID_NOT_FOUND = 'did-not-found'
const DID_UNAVAILABLE = 'did-unavailable'

/** `did:plc` only: no `did:web` (no age source, and it would let users make the Worker fetch arbitrary hosts). */
const plcOnlyDidResolver = {
  async resolve(did: string, options?: { signal?: AbortSignal }) {
    if (!PLC_DID_RE.test(did)) throw new DidError(did, 'Only did:plc identities are supported', UNSUPPORTED_DID_METHOD, 400)
    const res = await fetch(`https://plc.directory/${did}`, {
      redirect: 'manual',
      headers: { accept: 'application/did+ld+json,application/json' },
      signal: options?.signal ?? AbortSignal.timeout(8000),
    })
    if (res.status !== 200) {
      res.body?.cancel()
      throw new DidError(did, `PLC directory answered ${res.status}`, res.status === 404 ? DID_NOT_FOUND : DID_UNAVAILABLE, res.status === 404 ? 404 : 502)
    }
    return didDocumentValidator.parse(await res.json())
  },
}

// ---- stores ------------------------------------------------------------------------------------------------------------

/** Pending authorization requests in D1. The DPoP key is stored as its private JWK (ephemeral: bound to this 10-minute request). */
export function d1StateStore(env: Env, now: () => number = Date.now): StateStore {
  const db = getDb(env)
  return {
    async get(key) {
      const row = await db.select({ value: oauth_state_tab.value }).from(oauth_state_tab).where(and(eq(oauth_state_tab.key, key), gt(oauth_state_tab.expiresAt, now()))).get()
      if (!row) return undefined
      const { dpopKey, ...rest } = JSON.parse(row.value) as Omit<InternalStateData, 'dpopKey'> & { dpopKey: Record<string, unknown> }
      return { ...rest, dpopKey: await JoseKey.fromJWK(dpopKey) } satisfies InternalStateData
    },
    async set(key, value) {
      const { dpopKey, ...rest } = value
      const json = JSON.stringify({ ...rest, dpopKey: dpopKey.privateJwk })
      await db
        .insert(oauth_state_tab)
        .values({ key, value: json, expiresAt: now() + BSKY_STATE_TTL_MS })
        .onConflictDoUpdate({ target: oauth_state_tab.key, set: { value: json, expiresAt: now() + BSKY_STATE_TTL_MS } })
        .run()
    },
    async del(key) {
      await db.delete(oauth_state_tab).where(eq(oauth_state_tab.key, key)).run()
    },
  }
}

/** Sessions exist for the duration of one request and are never persisted. */
const memorySessionStore = (): SessionStore => {
  const map = new Map<string, Awaited<ReturnType<SessionStore['get']>>>()
  return {
    get: (key) => map.get(key),
    set: (key, value) => void map.set(key, value),
    del: (key) => void map.delete(key),
  } as SessionStore
}

// ---- the client --------------------------------------------------------------------------------------------------------

const sha = { sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' } as const

function errorChain(e: unknown): unknown[] {
  const out: unknown[] = []
  for (let cur = e; cur && out.length < 6; cur = (cur as { cause?: unknown }).cause) out.push(cur)
  return out
}

/** Library errors → our friendly codes; the raw message never reaches the user. */
function toAuthorizeError(e: unknown): AtprotoError {
  const chain = errorChain(e)
  if (chain.some((x) => x instanceof DidError && x.code === UNSUPPORTED_DID_METHOD)) return new AtprotoError('unsupported_did', { cause: e })
  if (chain.some((x) => x instanceof DidError && x.code === DID_UNAVAILABLE)) return new AtprotoError('unavailable', { cause: e })
  // The handle does not resolve to a DID (or the DID does not exist). Everything else (PDS without OAuth, network) is "unavailable".
  if (chain.some((x) => (x as { name?: string })?.name === 'IdentityResolverError' || (x instanceof DidError && x.code === DID_NOT_FOUND))) return new AtprotoError('handle_unresolved', { cause: e })
  return new AtprotoError('unavailable', { cause: e })
}

export function createAtprotoClient(env: Env, now: () => number = Date.now): OAuthClient {
  const { clientId, redirectUri, loopback } = clientIdentity(env)
  const options: OAuthClientOptions = {
    responseMode: 'query',
    clientMetadata: {
      client_id: clientId,
      redirect_uris: [redirectUri],
      scope: SCOPE,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'web',
      dpop_bound_access_tokens: true,
      ...(loopback ? {} : { client_name: BSKY_CLIENT_NAME, client_uri: baseUrl(env) }),
    } as OAuthClientOptions['clientMetadata'],
    allowHttp: loopback,
    stateStore: d1StateStore(env, now),
    sessionStore: memorySessionStore(),
    handleResolver: 'https://public.api.bsky.app',
    didResolver: plcOnlyDidResolver as unknown as OAuthClientOptions['didResolver'],
    fetch: workerdFetch,
    runtimeImplementation: {
      createKey: (algs) => JoseKey.generate(algs),
      getRandomValues: (length) => crypto.getRandomValues(new Uint8Array(length)),
      digest: async (data, alg) => new Uint8Array(await crypto.subtle.digest(sha[alg.name], data)),
    },
  }
  return new OAuthClient(options)
}

export const createAtprotoAuth: AtprotoAuthFactory = (env) => {
  const client = createAtprotoClient(env)
  const states = d1StateStore(env)
  return {
    async authorize(handleOrDid, state) {
      try {
        const url = await client.authorize(handleOrDid, { scope: SCOPE, state: JSON.stringify(state) })
        return url.toString()
      } catch (e) {
        throw toAuthorizeError(e)
      }
    },
    async peekState(stateKey) {
      try {
        const stored = await states.get(stateKey)
        const parsed = stored?.appState ? (JSON.parse(stored.appState) as Partial<FlowState>) : null
        return parsed && typeof parsed.o === 'string' && typeof parsed.nonce === 'string' ? { o: parsed.o, nonce: parsed.nonce, ...(typeof parsed.r === 'string' ? { r: parsed.r } : {}) } : null
      } catch {
        return null
      }
    },
    async callback(params) {
      let did: string
      try {
        const { session } = await client.callback(params)
        did = session.did
      } catch (e) {
        throw new AtprotoError('callback_failed', { cause: e })
      }
      // We only needed the identity. Best effort: the session was never persisted anyway.
      try {
        await client.revoke(did)
      } catch (e) {
        console.warn('bluesky: revoke failed', e instanceof Error ? e.message : e)
      }
      return { did }
    },
  }
}
