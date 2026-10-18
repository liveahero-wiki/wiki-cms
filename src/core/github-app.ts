// Generic GitHub App client (no wiki logic): RS256 app JWT -> installation token (cached in KV) -> a small REST client
// covering the contents / Git Data / pull request calls a type needs to turn an approved submission into a PR.

import type { Env } from '../env.ts'

const API = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const USER_AGENT = 'wiki-cms'
export const TOKEN_CACHE_KEY = 'github:installation-token'
/** Installation tokens last 1 h; cache for ~50 min so one KV write per hour is the most this ever does. */
export const TOKEN_CACHE_SECONDS = 50 * 60

/** A non-2xx answer (or a network failure, `status` 0). The message never contains credentials. */
export class GitHubError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'GitHubError'
    this.status = status
  }
}

export interface GitHubConfig {
  appId: string
  privateKey: string
  installationId: string
  /** `owner/name` */
  repo: string
  baseBranch: string
}

/** Reads the configuration from the environment; `missing` names what is not set (never values). */
export function githubConfig(env: Env): { ok: true; config: GitHubConfig } | { ok: false; missing: string[] } {
  const entries: [string, string | undefined][] = [
    ['GITHUB_APP_ID', env.GITHUB_APP_ID],
    ['GITHUB_APP_PRIVATE_KEY', env.GITHUB_APP_PRIVATE_KEY],
    ['GITHUB_APP_INSTALLATION_ID', env.GITHUB_APP_INSTALLATION_ID],
    ['GITHUB_REPO', env.GITHUB_REPO],
  ]
  const missing = entries.filter(([, v]) => !v || !v.trim()).map(([k]) => k)
  if (!missing.length && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPO!.trim())) missing.push('GITHUB_REPO (must look like owner/name)')
  if (missing.length) return { ok: false, missing }
  return {
    ok: true,
    config: {
      appId: env.GITHUB_APP_ID!.trim(),
      privateKey: env.GITHUB_APP_PRIVATE_KEY!,
      installationId: env.GITHUB_APP_INSTALLATION_ID!.trim(),
      repo: env.GITHUB_REPO!.trim(),
      baseBranch: env.GITHUB_BASE_BRANCH?.trim() || 'master',
    },
  }
}

// ---- encoding helpers ----
const b64url = (bytes: Uint8Array): string => {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const utf8 = (s: string) => new TextEncoder().encode(s)

/** Base64 (standard alphabet, whitespace allowed) to UTF-8 text. */
export function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

/** PKCS#8 PEM (real newlines or literal `\n` escapes, as pasted into a secret) to DER bytes. */
export function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const text = pem.replace(/\\r/g, '').replace(/\\n/g, '\n')
  if (/BEGIN RSA PRIVATE KEY/.test(text)) {
    throw new Error('GITHUB_APP_PRIVATE_KEY is a PKCS#1 key; convert it: openssl pkcs8 -topk8 -nocrypt -in app.pem -out app-pkcs8.pem')
  }
  const m = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/.exec(text)
  if (!m) throw new Error('GITHUB_APP_PRIVATE_KEY is not a PKCS#8 PEM (-----BEGIN PRIVATE KEY-----).')
  const bin = atob(m[1].replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Signs the short-lived (9 min) JWT that identifies the App itself. `nowMs` is injectable. */
export async function signAppJwt(appId: string, privateKeyPem: string, nowMs: number): Promise<string> {
  const iat = Math.floor(nowMs / 1000) - 60 // GitHub asks for a backdated iat to allow for clock drift
  const header = b64url(utf8(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))
  const payload = b64url(utf8(JSON.stringify({ iat, exp: iat + 9 * 60 + 60, iss: appId })))
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(privateKeyPem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf8(`${header}.${payload}`))
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`
}

async function rawFetch(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; data: any }> {
  let res: Response
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT, 'X-GitHub-Api-Version': API_VERSION, ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  } catch {
    throw new GitHubError(0, `GitHub ${method} ${path} could not be reached.`)
  }
  let data: any = null
  const text = await res.text().catch(() => '')
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }
  return { status: res.status, data }
}

function failure(method: string, path: string, status: number, data: any): GitHubError {
  const detail = data && typeof data.message === 'string' ? `: ${data.message.slice(0, 200)}` : ''
  return new GitHubError(status, `GitHub ${method} ${path} failed with ${status}${detail}`)
}

/** An installation access token, from KV when still fresh, else exchanged for a new app JWT (and cached ~50 min). */
export async function getInstallationToken(env: Env, config: GitHubConfig, nowMs: number): Promise<string> {
  const cached = await env.KV.get(TOKEN_CACHE_KEY)
  if (cached) return cached
  const jwt = await signAppJwt(config.appId, config.privateKey, nowMs)
  const path = `/app/installations/${encodeURIComponent(config.installationId)}/access_tokens`
  const { status, data } = await rawFetch('POST', path, { Authorization: `Bearer ${jwt}` })
  if (status !== 201 && status !== 200) throw failure('POST', path, status, data)
  const token = data?.token
  if (typeof token !== 'string' || !token) throw new GitHubError(status, `GitHub POST ${path} returned no token.`)
  await env.KV.put(TOKEN_CACHE_KEY, token, { expirationTtl: TOKEN_CACHE_SECONDS })
  return token
}

export async function clearInstallationToken(env: Env): Promise<void> {
  await env.KV.delete(TOKEN_CACHE_KEY)
}

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/')

export interface FileAtRef {
  sha: string
  text: string
}
export interface PullRequest {
  number: number
  url: string
  state: string
  headRef: string
}

/** REST client for one repository, authenticated with an installation token. */
export class GitHubClient {
  constructor(
    readonly repo: string,
    private readonly token: string,
  ) {}

  private async call(method: string, path: string, body?: unknown, ok: number[] = [200, 201]): Promise<any> {
    const { status, data } = await rawFetch(method, `/repos/${this.repo}${path}`, { Authorization: `Bearer ${this.token}` }, body)
    if (!ok.includes(status)) throw failure(method, `/repos/${this.repo}${path}`, status, data)
    return data
  }

  /** The file's blob sha and decoded UTF-8 text at a branch/commit, or null when it does not exist there. */
  async getFile(path: string, ref: string): Promise<FileAtRef | null> {
    const q = `/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`
    const { status, data } = await rawFetch('GET', `/repos/${this.repo}${q}`, { Authorization: `Bearer ${this.token}` })
    if (status === 404) return null
    if (status !== 200) throw failure('GET', `/repos/${this.repo}${q}`, status, data)
    if (!data || Array.isArray(data) || typeof data.sha !== 'string') throw new GitHubError(status, `GitHub returned no file for ${path}.`)
    // The contents API leaves `content` empty for files over 1 MB; the blob endpoint serves up to 100 MB.
    if (data.encoding === 'base64' && typeof data.content === 'string' && (data.content !== '' || data.size === 0)) {
      return { sha: data.sha, text: decodeBase64Utf8(data.content) }
    }
    return { sha: data.sha, text: await this.getBlob(data.sha) }
  }

  async getBlob(sha: string): Promise<string> {
    const data = await this.call('GET', `/git/blobs/${encodeURIComponent(sha)}`)
    if (data?.encoding !== 'base64' || typeof data.content !== 'string') throw new GitHubError(200, 'GitHub returned an unexpected blob encoding.')
    return decodeBase64Utf8(data.content)
  }

  /** Commit sha at the tip of a branch, or null when the branch does not exist. */
  async getBranchHead(branch: string): Promise<string | null> {
    const path = `/git/ref/heads/${encodePath(branch)}`
    const { status, data } = await rawFetch('GET', `/repos/${this.repo}${path}`, { Authorization: `Bearer ${this.token}` })
    if (status === 404) return null
    if (status !== 200) throw failure('GET', `/repos/${this.repo}${path}`, status, data)
    return data?.object?.sha ?? null
  }

  async getCommitTree(commitSha: string): Promise<string> {
    const data = await this.call('GET', `/git/commits/${encodeURIComponent(commitSha)}`)
    return data.tree.sha
  }

  async createBlob(text: string): Promise<string> {
    return (await this.call('POST', '/git/blobs', { content: text, encoding: 'utf-8' })).sha
  }

  /** A tree that replaces one file of `baseTree`. */
  async createTree(baseTree: string, path: string, blobSha: string): Promise<string> {
    return (await this.call('POST', '/git/trees', { base_tree: baseTree, tree: [{ path, mode: '100644', type: 'blob', sha: blobSha }] })).sha
  }

  async createCommit(message: string, tree: string, parents: string[]): Promise<string> {
    return (await this.call('POST', '/git/commits', { message, tree, parents })).sha
  }

  async createRef(branch: string, sha: string): Promise<void> {
    await this.call('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha })
  }

  /** Moves a branch; fast-forward only unless `force`. */
  async updateRef(branch: string, sha: string, force = false): Promise<void> {
    await this.call('PATCH', `/git/refs/heads/${encodePath(branch)}`, { sha, force })
  }

  /** The open pull request whose head is `branch` in this repository, if any. */
  async findOpenPullRequest(branch: string): Promise<PullRequest | null> {
    const owner = this.repo.split('/')[0]
    const list = await this.call('GET', `/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`)
    const hit = Array.isArray(list) ? list.find((d) => d?.head?.ref === branch) : null
    return hit ? toPr(hit) : null
  }

  async createPullRequest(input:{ title: string; head: string; base: string; body: string }): Promise<PullRequest> {
    return toPr(await this.call('POST', '/pulls', input))
  }

  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    if (labels.length) await this.call('POST', `/issues/${issueNumber}/labels`, { labels })
  }
}

function toPr(d: any): PullRequest {
  return { number: d.number, url: d.html_url, state: d.state, headRef: d.head?.ref ?? '' }
}

/** Builds a client for the configured repository (fetching/caching the installation token). */
export async function githubClient(env: Env, config: GitHubConfig, nowMs: number): Promise<GitHubClient> {
  return new GitHubClient(config.repo, await getInstallationToken(env, config, nowMs))
}
