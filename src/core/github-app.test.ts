import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Env } from '../env.ts'
import { GitHubClient, GitHubError, TOKEN_CACHE_KEY, TOKEN_CACHE_SECONDS, decodeBase64Utf8, getInstallationToken, githubConfig, pemToDer, signAppJwt } from './github-app.ts'

let publicKey: CryptoKey
let pem: string

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
  publicKey = pair.publicKey
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  pem = `-----BEGIN PRIVATE KEY-----\n${b64(der).match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`
})

afterEach(() => vi.unstubAllGlobals())

function fakeKv() {
  const store = new Map<string, string>()
  const kv = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
    delete: vi.fn(async (k: string) => void store.delete(k)),
  }
  return { kv, store }
}

const envWith = (kv: unknown, over: Partial<Env> = {}) =>
  ({ KV: kv, GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY: pem, GITHUB_APP_INSTALLATION_ID: '678', GITHUB_REPO: 'org/repo', ...over }) as unknown as Env

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

describe('signAppJwt', () => {
  it('is a well-formed RS256 JWT that verifies with the public key', async () => {
    const now = 1_800_000_000_000
    const jwt = await signAppJwt('12345', pem, now)
    const [h, p, s] = jwt.split('.')
    expect(JSON.parse(new TextDecoder().decode(unb64url(h)))).toEqual({ alg: 'RS256', typ: 'JWT' })
    const claims = JSON.parse(new TextDecoder().decode(unb64url(p)))
    expect(claims).toEqual({ iat: 1_800_000_000 - 60, exp: 1_800_000_000 + 9 * 60, iss: '12345' })
    expect(jwt).not.toMatch(/[+/=]/)
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, unb64url(s), new TextEncoder().encode(`${h}.${p}`))).toBe(true)
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, unb64url(s), new TextEncoder().encode(`${h}.${p}x`))).toBe(false)
  })

  it('accepts a PEM with literal \\n escapes (as pasted into a secret)', async () => {
    const escaped = pem.trim().replace(/\n/g, '\\n')
    expect(escaped).not.toContain('\n')
    expect(pemToDer(escaped)).toEqual(pemToDer(pem))
    const jwt = await signAppJwt('1', escaped, 1_800_000_000_000)
    const [h, p, s] = jwt.split('.')
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, unb64url(s), new TextEncoder().encode(`${h}.${p}`))).toBe(true)
  })

  it('explains PKCS#1 keys and garbage without echoing the key', () => {
    expect(() => pemToDer('-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----')).toThrow(/PKCS#1.*openssl pkcs8/)
    expect(() => pemToDer('secret-garbage-123')).toThrow(/PKCS#8/)
    try {
      pemToDer('secret-garbage-123')
    } catch (e) {
      expect(String(e)).not.toContain('secret-garbage-123')
    }
  })
})

describe('githubConfig', () => {
  it('lists what is missing (names only) and defaults the base branch', () => {
    const none = githubConfig({} as Env)
    expect(none).toEqual({ ok: false, missing: ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_INSTALLATION_ID', 'GITHUB_REPO'] })
    const ok = githubConfig(envWith(null))
    expect(ok).toMatchObject({ ok: true, config: { appId: '12345', installationId: '678', repo: 'org/repo', baseBranch: 'master' } })
    expect(githubConfig(envWith(null, { GITHUB_BASE_BRANCH: 'main' }))).toMatchObject({ config: { baseBranch: 'main' } })
    expect(githubConfig(envWith(null, { GITHUB_REPO: 'not a repo' }))).toMatchObject({ ok: false })
    expect(githubConfig(envWith(null, { GITHUB_APP_ID: '  ' }))).toMatchObject({ ok: false, missing: ['GITHUB_APP_ID'] })
  })
})

describe('installation token', () => {
  it('exchanges the JWT, sends the required headers and caches the token for ~50 minutes', async () => {
    const { kv } = fakeKv()
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json({ token: 'ghs_secret', expires_at: 'x' }, 201))
    vi.stubGlobal('fetch', fetchMock)
    const env = envWith(kv)
    const cfg = (githubConfig(env) as { config: Parameters<typeof getInstallationToken>[1] }).config

    expect(await getInstallationToken(env, cfg, 1_800_000_000_000)).toBe('ghs_secret')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.github.com/app/installations/678/access_tokens')
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Record<string, string>
    expect(headers['User-Agent']).toBeTruthy()
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28')
    expect(headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    expect(kv.put).toHaveBeenCalledTimes(1)
    expect(kv.put).toHaveBeenCalledWith(TOKEN_CACHE_KEY, 'ghs_secret', { expirationTtl: TOKEN_CACHE_SECONDS })
    expect(TOKEN_CACHE_SECONDS).toBe(3000)

    // second call: from KV, no network, no KV write
    expect(await getInstallationToken(env, cfg, 1_800_000_060_000)).toBe('ghs_secret')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(kv.put).toHaveBeenCalledTimes(1)
  })

  it('errors carry the status and the GitHub message, never a credential', async () => {
    const { kv } = fakeKv()
    vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'Bad credentials' }, 401)))
    const env = envWith(kv)
    const cfg = (githubConfig(env) as { config: Parameters<typeof getInstallationToken>[1] }).config
    const err = await getInstallationToken(env, cfg, 1_800_000_000_000).catch((e) => e)
    expect(err).toBeInstanceOf(GitHubError)
    expect(err.status).toBe(401)
    expect(err.message).toContain('401')
    expect(err.message).toContain('Bad credentials')
    expect(err.message).not.toMatch(/Bearer|eyJ|BEGIN/)
    expect(kv.put).not.toHaveBeenCalled()
  })
})

describe('GitHubClient', () => {
  const calls: { method: string; url: string; headers: Record<string, string>; body: any }[] = []
  const stub = (handler: (method: string, path: string, body: any) => Response) => {
    calls.length = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        calls.push({ method: init?.method ?? 'GET', url: input, headers: init?.headers as Record<string, string>, body })
        return handler(init?.method ?? 'GET', input.replace('https://api.github.com', ''), body)
      }),
    )
  }
  const client = new GitHubClient('org/repo', 'ghs_tok')
  const b64utf8 = (s: string) => b64(new TextEncoder().encode(s))

  it('getFile decodes base64 UTF-8 (with line breaks) and returns the sha', async () => {
    const text = '---\nt: 日本語 ✓\n---\nbody\n'
    const enc = b64utf8(text).replace(/(.{20})/g, '$1\n')
    stub(() => json({ type: 'file', sha: 'abc', encoding: 'base64', content: enc, size: text.length }))
    expect(await client.getFile('_charas/a b.md', 'master')).toEqual({ sha: 'abc', text })
    expect(calls[0].url).toBe('https://api.github.com/repos/org/repo/contents/_charas/a%20b.md?ref=master')
    expect(calls[0].headers).toMatchObject({ Authorization: 'Bearer ghs_tok', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': expect.any(String) })
  })

  it('getFile returns null for 404, falls back to the blob API for large files, throws on other statuses', async () => {
    stub(() => json({ message: 'Not Found' }, 404))
    expect(await client.getFile('mobs.md', 'master')).toBeNull()
    stub((_m, path) => (path.includes('/contents/') ? json({ sha: 'big', encoding: 'none', content: '', size: 2_000_000 }) : json({ encoding: 'base64', content: b64utf8('large text') })))
    expect(await client.getFile('mobs.md', 'master')).toEqual({ sha: 'big', text: 'large text' })
    expect(calls[1].url).toBe('https://api.github.com/repos/org/repo/git/blobs/big')
    stub(() => json({ message: 'Server Error' }, 500))
    await expect(client.getFile('mobs.md', 'master')).rejects.toMatchObject({ name: 'GitHubError', status: 500 })
  })

  it('getBlob decodes base64; an unexpected encoding is an error', async () => {
    stub(() => json({ encoding: 'base64', content: b64utf8('héllo') }))
    expect(await client.getBlob('s1')).toBe('héllo')
    stub(() => json({ encoding: 'utf-8', content: 'x' }))
    await expect(client.getBlob('s1')).rejects.toBeInstanceOf(GitHubError)
  })

  it('getBranchHead is null for a missing branch', async () => {
    stub(() => json({ message: 'Not Found' }, 404))
    expect(await client.getBranchHead('contrib/x')).toBeNull()
    stub(() => json({ object: { sha: 'c0ffee' } }))
    expect(await client.getBranchHead('contrib/x')).toBe('c0ffee')
    expect(calls[0].url).toBe('https://api.github.com/repos/org/repo/git/ref/heads/contrib/x')
  })

  it('Git Data and pull request calls send the expected requests', async () => {
    stub((method, path) => {
      if (path.endsWith('/git/blobs')) return json({ sha: 'blob1' }, 201)
      if (path.endsWith('/git/trees')) return json({ sha: 'tree1' }, 201)
      if (path.endsWith('/git/commits')) return json({ sha: 'commit1' }, 201)
      if (path.endsWith('/git/refs')) return json({}, 201)
      if (path.includes('/git/refs/heads/')) return json({})
      if (path.endsWith('/pulls')) return json({ number: 7, html_url: 'https://github.com/org/repo/pull/7', state: 'open', head: { ref: 'contrib/x' } }, 201)
      return json({}, 200)
    })
    expect(await client.createBlob('text')).toBe('blob1')
    expect(await client.createTree('base', 'mobs.md', 'blob1')).toBe('tree1')
    expect(await client.createCommit('msg', 'tree1', ['p1', 'p2'])).toBe('commit1')
    await client.createRef('contrib/x', 'commit1')
    await client.updateRef('contrib/x', 'commit2')
    expect(await client.createPullRequest({ title: 't', head: 'contrib/x', base: 'master', body: 'b' })).toEqual({ number: 7, url: 'https://github.com/org/repo/pull/7', state: 'open', headRef: 'contrib/x' })
    await client.addLabels(7, ['community-edit'])
    expect(calls.map((c) => [c.method, c.url.replace('https://api.github.com/repos/org/repo', ''), c.body])).toEqual([
      ['POST', '/git/blobs', { content: 'text', encoding: 'utf-8' }],
      ['POST', '/git/trees', { base_tree: 'base', tree: [{ path: 'mobs.md', mode: '100644', type: 'blob', sha: 'blob1' }] }],
      ['POST', '/git/commits', { message: 'msg', tree: 'tree1', parents: ['p1', 'p2'] }],
      ['POST', '/git/refs', { ref: 'refs/heads/contrib/x', sha: 'commit1' }],
      ['PATCH', '/git/refs/heads/contrib/x', { sha: 'commit2', force: false }],
      ['POST', '/pulls', { title: 't', head: 'contrib/x', base: 'master', body: 'b' }],
      ['POST', '/issues/7/labels', { labels: ['community-edit'] }],
    ])
  })

  it('non-2xx becomes a GitHubError with status, method, path and the API message (never the token)', async () => {
    stub(() => json({ message: 'Reference already exists', documentation_url: 'x' }, 422))
    const err = await client.createRef('contrib/x', 'sha').catch((e) => e)
    expect(err).toBeInstanceOf(GitHubError)
    expect(err.status).toBe(422)
    expect(err.message).toBe('GitHub POST /repos/org/repo/git/refs failed with 422: Reference already exists')
    expect(err.message).not.toContain('ghs_tok')
  })

  it('a network failure is a GitHubError with status 0; a non-JSON error body is tolerated', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('boom ghs_tok'))))
    const net = await client.createBlob('x').catch((e) => e)
    expect(net).toBeInstanceOf(GitHubError)
    expect(net.status).toBe(0)
    expect(net.message).not.toContain('ghs_tok')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 })))
    await expect(client.createBlob('x')).rejects.toMatchObject({ status: 502, message: 'GitHub POST /repos/org/repo/git/blobs failed with 502' })
  })
})

describe('decodeBase64Utf8', () => {
  it('round-trips multi-byte text', () => {
    expect(decodeBase64Utf8(b64(new TextEncoder().encode('a€😀\n')))).toBe('a€😀\n')
  })
})
