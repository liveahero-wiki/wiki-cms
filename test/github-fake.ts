import { vi } from 'vitest'

// An in-memory api.github.com for one repository (contents, Git Data, pull requests, labels, installation tokens).
// `installGithubFake` wraps the current global fetch stub, so Discord/groups/Turnstile stubs from resetState keep working.

const hex40 = (n: number, prefix: string) => (prefix + n.toString(16)).padStart(40, '0')

export async function gitBlobSha(text: string): Promise<string> {
  const body = new TextEncoder().encode(text)
  const head = new TextEncoder().encode(`blob ${body.length}\0`)
  const all = new Uint8Array(head.length + body.length)
  all.set(head)
  all.set(body, head.length)
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1', all))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))

export interface FakePr {
  number: number
  title: string
  head: string
  base: string
  body: string
  state: 'open' | 'closed'
  labels: string[]
}

export interface GitHubFake {
  repo: string
  baseBranch: string
  calls: { method: string; path: string; body: any; auth: string | null }[]
  /** Throws away every call so far. */
  clear(): void
  tokenRequests(): number
  /** Number of calls whose method + path matches. */
  count(method: string, pathPart: string): number
  /** Replaces a file on master (new commit) and returns its blob sha. */
  setFile(path: string, text: string): Promise<string>
  deleteFile(path: string): void
  /** Text of `path` at a branch or the base branch, following created trees/commits. */
  fileAt(branch: string, path: string): string | null
  headOf(branch: string): string | undefined
  commit(sha: string): { tree: string; parents: string[]; message: string } | undefined
  prs: Map<number, FakePr>
  /** Make the next matching calls fail: return an HTTP status (0 = network error) to fail, or null to pass. */
  failWhen: ((method: string, path: string) => number | null) | null
}

export function installGithubFake(repo = 'org/wiki', baseBranch = 'master'): GitHubFake {
  const files = new Map<string, { sha: string; text: string }>()
  const blobs = new Map<string, string>()
  const refs = new Map<string, string>()
  const commits = new Map<string, { tree: string; parents: string[]; message: string }>()
  const trees = new Map<string, { base: string; path: string; blob: string }>()
  const prs = new Map<number, FakePr>()
  let seq = 1
  let tokens = 0
  let prSeq = 41

  const newMasterCommit = () => {
    const sha = hex40(seq++, 'c')
    commits.set(sha, { tree: `master-tree-${sha}`, parents: [], message: 'master' })
    refs.set(baseBranch, sha)
    return sha
  }
  newMasterCommit()

  const fake: GitHubFake = {
    repo,
    baseBranch,
    calls: [],
    prs,
    failWhen: null,
    clear: () => void (fake.calls.length = 0),
    tokenRequests: () => tokens,
    count: (method, part) => fake.calls.filter((c) => c.method === method && c.path.includes(part)).length,
    async setFile(path, text) {
      const sha = await gitBlobSha(text)
      files.set(path, { sha, text })
      blobs.set(sha, text)
      newMasterCommit()
      return sha
    },
    deleteFile(path) {
      files.delete(path)
      newMasterCommit()
    },
    fileAt(branch, path) {
      const head = refs.get(branch)
      if (!head) return null
      let tree = commits.get(head)!.tree
      while (trees.has(tree)) {
        const t = trees.get(tree)!
        if (t.path === path) return blobs.get(t.blob) ?? null
        tree = t.base
      }
      return files.get(path)?.text ?? null
    },
    headOf: (branch) => refs.get(branch),
    commit: (sha) => commits.get(sha),
  }

  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
  const notFound = () => json({ message: 'Not Found' }, 404)

  async function handle(method: string, path: string, body: any): Promise<Response> {
    if (/^\/app\/installations\/[^/]+\/access_tokens$/.test(path)) {
      tokens++
      return json({ token: 'ghs_fake_installation_token', expires_at: '2099-01-01T00:00:00Z' }, 201)
    }
    const prefix = `/repos/${repo}`
    if (!path.startsWith(prefix)) return notFound()
    const rest = path.slice(prefix.length)
    let m: RegExpExecArray | null

    if (method === 'GET' && (m = /^\/contents\/(.+)\?ref=(.+)$/.exec(rest))) {
      const file = files.get(decodeURIComponent(m[1]))
      if (!file) return notFound()
      return json({ type: 'file', sha: file.sha, size: file.text.length, encoding: 'base64', content: b64(file.text).replace(/(.{60})/g, '$1\n') })
    }
    if (method === 'GET' && (m = /^\/git\/blobs\/([0-9a-f]+)$/.exec(rest))) {
      const text = blobs.get(m[1])
      return text === undefined ? notFound() : json({ sha: m[1], encoding: 'base64', content: b64(text) })
    }
    if (method === 'GET' && (m = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
      const sha = refs.get(decodeURIComponent(m[1]))
      return sha ? json({ ref: `refs/heads/${m[1]}`, object: { sha, type: 'commit' } }) : notFound()
    }
    if (method === 'GET' && (m = /^\/git\/commits\/([0-9a-f]+)$/.exec(rest))) {
      const c = commits.get(m[1])
      return c ? json({ sha: m[1], tree: { sha: c.tree } }) : notFound()
    }
    if (method === 'POST' && rest === '/git/blobs') {
      const sha = await gitBlobSha(body.content)
      blobs.set(sha, body.content)
      return json({ sha }, 201)
    }
    if (method === 'POST' && rest === '/git/trees') {
      const sha = hex40(seq++, 'a')
      trees.set(sha, { base: body.base_tree, path: body.tree[0].path, blob: body.tree[0].sha })
      return json({ sha }, 201)
    }
    if (method === 'POST' && rest === '/git/commits') {
      const sha = hex40(seq++, 'd')
      commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message })
      return json({ sha }, 201)
    }
    if (method === 'POST' && rest === '/git/refs') {
      const name = String(body.ref).replace(/^refs\/heads\//, '')
      if (refs.has(name)) return json({ message: 'Reference already exists' }, 422)
      refs.set(name, body.sha)
      return json({ ref: body.ref }, 201)
    }
    if (method === 'PATCH' && (m = /^\/git\/refs\/heads\/(.+)$/.exec(rest))) {
      const name = decodeURIComponent(m[1])
      if (!refs.has(name)) return notFound()
      refs.set(name, body.sha)
      return json({ ref: `refs/heads/${name}` })
    }
    if (method === 'GET' && (m = /^\/pulls\?state=open&head=(.+)$/.exec(rest))) {
      const head = decodeURIComponent(m[1]).split(':').slice(1).join(':')
      return json([...prs.values()].filter((p) => p.state === 'open' && p.head === head).map(prJson))
    }
    if (method === 'POST' && rest === '/pulls') {
      if ([...prs.values()].some((p) => p.state === 'open' && p.head === body.head)) return json({ message: 'A pull request already exists' }, 422)
      const pr: FakePr = { number: prSeq++, title: body.title, head: body.head, base: body.base, body: body.body, state: 'open', labels: [] }
      prs.set(pr.number, pr)
      return json(prJson(pr), 201)
    }
    if (method === 'POST' && (m = /^\/issues\/(\d+)\/labels$/.exec(rest))) {
      const pr = prs.get(Number(m[1]))
      if (!pr) return notFound()
      pr.labels.push(...body.labels)
      return json(pr.labels.map((name) => ({ name })))
    }
    return json({ message: `fake GitHub: unhandled ${method} ${rest}` }, 500)
  }

  const prJson = (pr: FakePr) => ({ number: pr.number, html_url: `https://github.com/${repo}/pull/${pr.number}`, state: pr.state, head: { ref: pr.head } })

  const previous = globalThis.fetch
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (!url.startsWith('https://api.github.com/')) return previous(input as RequestInfo, init)
      const method = init?.method ?? 'GET'
      const path = url.slice('https://api.github.com'.length)
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      const headers = (init?.headers ?? {}) as Record<string, string>
      fake.calls.push({ method, path, body, auth: headers.Authorization ?? null })
      const fail = fake.failWhen?.(method, path)
      if (fail === 0) throw new TypeError('network down')
      if (fail) return json({ message: 'injected failure' }, fail)
      return handle(method, path, body)
    }),
  )
  return fake
}

/** A fresh RSA key as a PKCS#8 PEM, for GITHUB_APP_PRIVATE_KEY in tests. */
export async function testPrivateKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der)).match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`
}
