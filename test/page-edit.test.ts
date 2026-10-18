import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ORIGIN, contribApi, contribLogin, makeHarness, resetState, rows, seedType, sessionCookie, type Harness } from './helpers.ts'
import { gitBlobSha, installGithubFake, testPrivateKeyPem, type GitHubFake } from './github-fake.ts'

const PAGE = 'lah-page-edit'
const PATH = '_charas/ryekie.md'
const FM = '---\ntitle: Ryekie\nlayout: chara\n---\n'
const BODY = '## Notes\nOld notes.\n'
const SECRET = 'whsec-test-secret'

let pem: string
let h: Harness
let gh: GitHubFake
let baseSha: string
let clock = Date.now()
const json = async <T = any>(r: Response) => (await r.json()) as T

beforeAll(async () => {
  pem = await testPrivateKeyPem()
})

const config = (over: Record<string, unknown> = {}) => ({
  GITHUB_APP_ID: '123',
  GITHUB_APP_PRIVATE_KEY: pem,
  GITHUB_APP_INSTALLATION_ID: '9',
  GITHUB_REPO: 'org/wiki',
  GITHUB_BASE_BRANCH: 'master',
  GITHUB_WEBHOOK_SECRET: SECRET,
  GITHUB_PREVIEW_LABEL: undefined,
  ...over,
})

async function setup(envOver: Record<string, unknown> = {}) {
  await resetState()
  clock = Date.now()
  gh = installGithubFake('org/wiki', 'master')
  baseSha = await gh.setFile(PATH, FM + BODY)
  h = makeHarness({ now: () => clock }, config(envOver))
  await seedType(PAGE, { submitAuth: 'anonymous' })
}
beforeEach(() => setup())

let ipSeq = 0
const edit = (over: Record<string, unknown> = {}) => ({ path: PATH, baseSha, after: '## Notes\nNew notes.\n\n## Usage guide\nDo this.\n', summary: 'Add usage guide', ...over })

async function submit(userId = 'c1', payload: Record<string, unknown> = edit(), displayName = 'Alice') {
  const token = await contribLogin(userId, { displayName })
  const res = await contribApi(h, token, 'POST', `/submissions/${PAGE}/all`, { payload, tags: {}, lang: 'en', turnstileToken: 'tok', website: '' }, { 'CF-Connecting-IP': `203.0.113.${100 + (ipSeq++ % 100)}` })
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(202)
  return { id: (await json<{ id: string }>(res)).id, token }
}

const admin = (cookie: string, method: string, path: string, body?: unknown) =>
  h.fetch(`/api/admin${path}`, {
    method,
    headers: { Cookie: cookie, Origin: 'http://localhost:8787', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const modCookie = () => sessionCookie('mod', { types: [PAGE] })
const setState = (cookie: string, id: string, version: number, state: string) => admin(cookie, 'POST', `/submissions/${id}/state`, { expectedVersion: version, state })
const mine = async (token: string) => (await json(await contribApi(h, token, 'GET', `/submissions?type=${PAGE}`))).items as { id: string; state: string; outcome: any }[]
const row = async (id: string) => (await rows(`id='${id}'`))[0]!
const external = async (id: string) => JSON.parse((await row(id)).external as string)

describe('lah-page-edit submission', () => {
  it('is registered, account-only and stores no title/explanation/demo', async () => {
    const anon = await h.fetch(`/api/v1/submissions/${PAGE}/all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.9' },
      body: JSON.stringify({ payload: edit(), tags: {}, lang: 'en', turnstileToken: 'tok', website: '' }),
    })
    expect([401, 403]).toContain(anon.status)
    const { id, token } = await submit()
    expect(await row(id)).toMatchObject({ type: PAGE, group_id: 'all', state: 'pending', title: '', explanation: '', demo_url: '', external: null })
    const put = await contribApi(h, token, 'PUT', `/submissions/${id}`, { payload: edit({ summary: 'Another' }), tags: {}, lang: 'en', expectedVersion: 1, turnstileToken: 'tok', website: '' })
    expect(put.status).toBe(403)
    expect(gh.calls).toHaveLength(0) // nothing touches GitHub before approval
  })

  it('rejects an invalid payload with field errors', async () => {
    const token = await contribLogin('c1')
    const res = await contribApi(h, token, 'POST', `/submissions/${PAGE}/all`, { payload: edit({ path: '_posts/x.md', after: '---\nx: 1\n---\n' }), tags: {}, lang: 'en', turnstileToken: 'tok', website: '' })
    expect(res.status).toBe(400)
    expect((await json(res)).error.fields.map((f: { path: string }) => f.path)).toEqual(['path', 'after'])
  })

  it('accepts a body above the default 32 KB cap (own 128 KB cap)', async () => {
    const token = await contribLogin('c1')
    const res = await contribApi(h, token, 'POST', `/submissions/${PAGE}/all`, { payload: edit({ after: 'x'.repeat(100_000) }), tags: {}, lang: 'en', turnstileToken: 'tok', website: '' })
    expect(res.status).toBe(202)
  })
})

describe('approval -> pull request', () => {
  it('creates the branch, commit and PR, labels it and never merges', async () => {
    const { id, token } = await submit('c1', edit(), 'Alice')
    const mod = await modCookie()
    const res = await setState(mod, id, 1, 'approved')
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)

    const branch = `contrib/${id}`
    const body = await json(res)
    expect(body.item.state).toBe('approved')
    expect(body.item.external).toEqual({
      outcome: { status: 'pr_open', url: 'https://github.com/org/wiki/pull/41', label: 'Pull request #41 is open for review' },
      pr: { number: 41, branch, url: 'https://github.com/org/wiki/pull/41' },
    })

    // branch -> single commit on the current master head, message with trailer, tree holds front matter + after
    const commit = gh.commit(gh.headOf(branch)!)!
    expect(commit.parents).toEqual([gh.headOf('master')])
    expect(commit.message).toBe(`Add usage guide\n\nSubmitted via wiki-cms #${id.slice(0, 8)}\n\nCo-authored-by: Alice <contrib-c1@users.invalid>`)
    expect(gh.fileAt(branch, PATH)).toBe(FM + edit().after)
    expect(gh.fileAt('master', PATH)).toBe(FM + BODY) // master untouched

    // PR
    const pr = gh.prs.get(41)!
    expect(pr).toMatchObject({ title: 'Add usage guide', head: branch, base: 'master', state: 'open', labels: ['community-edit'] })
    expect(pr.body).toContain(id)
    expect(pr.body).toContain(PATH)
    expect(pr.body).toMatch(/submitted through the wiki editor/i)
    expect(pr.body).toMatch(/maintainer must review/i)
    expect(pr.labels).not.toContain('committer-approved')

    // no merge / auto-merge / master writes
    expect(gh.calls.filter((c) => /merge|auto_merge|graphql/i.test(c.path))).toEqual([])
    expect(gh.calls.filter((c) => c.method !== 'GET' && c.path.includes('heads/master'))).toEqual([])
    // every repo call carries the installation token, one token exchange
    expect(gh.tokenRequests()).toBe(1)
    expect(gh.calls.filter((c) => c.path.startsWith('/repos/')).every((c) => c.auth === 'Bearer ghs_fake_installation_token')).toBe(true)

    // owner view: the outcome only
    const [own] = await mine(token)
    expect(own.state).toBe('approved')
    expect(own.outcome).toEqual({ status: 'pr_open', url: 'https://github.com/org/wiki/pull/41', label: 'Pull request #41 is open for review' })
    expect(JSON.stringify(own)).not.toContain(branch)
  })

  it('adds the preview label only when GITHUB_PREVIEW_LABEL is set', async () => {
    await setup({ GITHUB_PREVIEW_LABEL: 'committer-approved' })
    const { id } = await submit()
    expect((await setState(await modCookie(), id, 1, 'approved')).status).toBe(200)
    expect(gh.prs.get(41)!.labels).toEqual(['community-edit', 'committer-approved'])
  })

  it('a label failure does not fail the approval (the PR exists)', async () => {
    gh.failWhen = (m, p) => (p.includes('/labels') ? 403 : null)
    const { id } = await submit()
    expect((await setState(await modCookie(), id, 1, 'approved')).status).toBe(200)
    expect(gh.prs.size).toBe(1)
  })

  it('uses the current front matter when only the front matter changed since baseSha', async () => {
    const { id } = await submit()
    const newFm = '---\ntitle: Ryekie\nlayout: chara\nnew_key: 1\n---\n'
    await gh.setFile(PATH, newFm + BODY)
    expect((await setState(await modCookie(), id, 1, 'approved')).status).toBe(200)
    expect(gh.fileAt(`contrib/${id}`, PATH)).toBe(newFm + edit().after)
    // a master that moved on (new head) is the parent
    expect(gh.commit(gh.headOf(`contrib/${id}`)!)!.parents).toEqual([gh.headOf('master')])
  })

  it('keeps the other parts of the new file byte-exact (CRLF in the front matter)', async () => {
    const fm = '---\r\ntitle: X\r\n---\r\n'
    baseSha = await gh.setFile(PATH, fm + BODY)
    const { id } = await submit()
    expect((await setState(await modCookie(), id, 1, 'approved')).status).toBe(200)
    expect(gh.fileAt(`contrib/${id}`, PATH)).toBe(fm + edit().after)
  })

  it('works for a page without front matter', async () => {
    baseSha = await gh.setFile('mobs.md', 'old body\n')
    const { id } = await submit('c1', edit({ path: 'mobs.md', after: 'new body\n' }))
    expect((await setState(await modCookie(), id, 1, 'approved')).status).toBe(200)
    expect(gh.fileAt(`contrib/${id}`, 'mobs.md')).toBe('new body\n')
  })

  it('writes an audit entry for the approval', async () => {
    const { id } = await submit()
    const mod = await modCookie()
    await setState(mod, id, 1, 'approved')
    const audit = (await json(await admin(mod, 'GET', '/audit'))).entries as { action: string; target: string }[]
    expect(audit.find((a) => a.action === 'submission.approved')?.target).toBe(id)
  })

  it('is refused in bulk (moderators approve page edits one by one)', async () => {
    const { id } = await submit()
    const res = await admin(await modCookie(), 'POST', '/submissions/bulk-state', { ids: [id], state: 'approved' })
    expect(res.status).toBe(400)
    expect(gh.calls).toHaveLength(0)
  })
})

describe('conflicts', () => {
  it('a body that changed since baseSha is a conflict: 409, stays pending, stored for the moderator and the owner, nothing written to GitHub', async () => {
    const { id, token } = await submit()
    const currentSha = await gh.setFile(PATH, FM + '## Notes\nSomeone else edited this.\n')
    gh.clear()
    const res = await setState(await modCookie(), id, 1, 'approved')
    expect(res.status).toBe(409)
    expect((await json(res)).error.code).toBe('base_conflict')
    expect(gh.calls.filter((c) => c.method !== 'GET' && c.path.startsWith('/repos/'))).toEqual([])
    expect(await row(id)).toMatchObject({ state: 'pending', version: 1 })
    const ext = await external(id)
    expect(ext).toMatchObject({ outcome: { status: 'conflict' }, currentSha })
    expect(ext.outcome.label).toContain('baseSha')
    expect((await mine(token))[0].outcome.status).toBe('conflict')
  })

  it('editing the payload (new baseSha) clears the conflict and the approval then succeeds', async () => {
    const { id } = await submit()
    const currentSha = await gh.setFile(PATH, FM + '## Notes\nSomeone else edited this.\n')
    const mod = await modCookie()
    expect((await setState(mod, id, 1, 'approved')).status).toBe(409)
    const patched = await admin(mod, 'PATCH', `/submissions/${id}`, { expectedVersion: 1, payload: edit({ baseSha: currentSha, after: '## Notes\nMerged by hand.\n' }) })
    expect(patched.status, JSON.stringify(await patched.clone().json())).toBe(200)
    expect((await row(id)).external).toBeNull()
    expect((await setState(mod, id, 2, 'approved')).status).toBe(200)
    expect(gh.fileAt(`contrib/${id}`, PATH)).toBe(FM + '## Notes\nMerged by hand.\n')
  })

  it('an unknown baseSha counts as a conflict', async () => {
    const { id } = await submit('c1', edit({ baseSha: 'b'.repeat(40) }))
    await gh.setFile(PATH, FM + 'changed\n')
    const res = await setState(await modCookie(), id, 1, 'approved')
    expect(res.status).toBe(409)
    expect((await json(res)).error.code).toBe('base_conflict')
  })

  it('a page deleted on master is a conflict', async () => {
    const { id } = await submit()
    gh.deleteFile(PATH)
    const res = await setState(await modCookie(), id, 1, 'approved')
    expect(res.status).toBe(409)
    expect((await external(id)).outcome.status).toBe('conflict')
  })

  it('an edit that changes nothing is refused (400) instead of opening an empty PR', async () => {
    const { id } = await submit('c1', edit({ after: BODY }))
    const res = await setState(await modCookie(), id, 1, 'approved')
    expect(res.status).toBe(400)
    expect((await json(res)).error.code).toBe('no_change')
    expect(gh.prs.size).toBe(0)
  })
})

describe('re-approval is idempotent', () => {
  it('updates the existing branch and PR instead of opening a second one', async () => {
    const { id } = await submit()
    const mod = await modCookie()
    expect((await setState(mod, id, 1, 'approved')).status).toBe(200) // v2
    const branch = `contrib/${id}`
    const firstHead = gh.headOf(branch)!
    expect((await setState(mod, id, 2, 'pending')).status).toBe(200) // v3
    expect((await admin(mod, 'PATCH', `/submissions/${id}`, { expectedVersion: 3, payload: edit({ after: '## Notes\nMy second version.\n' }) })).status).toBe(200) // v4
    // master moved on meanwhile (unrelated page)
    await gh.setFile('mobs.md', 'mobs\n')
    gh.clear()
    const res = await setState(mod, id, 4, 'approved')
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)

    expect(gh.count('POST', '/pulls')).toBe(0)
    expect(gh.count('POST', '/git/refs')).toBe(0)
    expect(gh.count('PATCH', `/git/refs/heads/${branch}`)).toBe(1)
    expect(gh.prs.size).toBe(1)
    expect(gh.prs.get(41)!.labels).toEqual(['community-edit']) // not labelled twice
    const head = gh.headOf(branch)!
    expect(head).not.toBe(firstHead)
    expect(gh.commit(head)!.parents).toEqual([firstHead, gh.headOf('master')]) // fast-forward, also merges the current base
    expect(gh.fileAt(branch, PATH)).toBe(FM + '## Notes\nMy second version.\n')
    expect((await json(res)).item.external.pr).toEqual({ number: 41, branch, url: 'https://github.com/org/wiki/pull/41' })
  })

  it('opens a new PR from the same branch when the previous one was closed', async () => {
    const { id } = await submit()
    const mod = await modCookie()
    await setState(mod, id, 1, 'approved')
    gh.prs.get(41)!.state = 'closed'
    await setState(mod, id, 2, 'pending')
    const res = await setState(mod, id, 3, 'approved')
    expect(res.status).toBe(200)
    expect(gh.prs.size).toBe(2)
    expect((await json(res)).item.external.pr.number).toBe(42)
    expect(gh.prs.get(42)!.head).toBe(`contrib/${id}`)
  })
})

describe('failures', () => {
  it('a GitHub 5xx while writing -> 502 github_error, still pending, nothing stored, no secrets in the message', async () => {
    const { id } = await submit()
    gh.failWhen = (m, p) => (m === 'POST' && p.endsWith('/git/blobs') ? 500 : null)
    const res = await setState(await modCookie(), id, 1, 'approved')
    expect(res.status).toBe(502)
    const err = (await json(res)).error
    expect(err.code).toBe('github_error')
    expect(err.message).toContain('500')
    expect(err.message).not.toMatch(/ghs_|BEGIN|Bearer/)
    expect(await row(id)).toMatchObject({ state: 'pending', version: 1, external: null })
    // retry works once GitHub is back
    gh.failWhen = null
    expect((await setState(await modCookie(), id, 1, 'approved')).status).toBe(200)
  })

  it('a failed PR creation after the branch exists is recovered on retry (no duplicate branch error)', async () => {
    const { id } = await submit()
    const mod = await modCookie()
    gh.failWhen = (m, p) => (m === 'POST' && p.endsWith('/pulls') ? 502 : null)
    expect((await setState(mod, id, 1, 'approved')).status).toBe(502)
    gh.failWhen = null
    expect((await setState(mod, id, 1, 'approved')).status).toBe(200)
    expect(gh.prs.size).toBe(1)
  })

  it('adopts an open PR whose number was never stored (the save after opening it was lost)', async () => {
    const { id } = await submit()
    const mod = await modCookie()
    expect((await setState(mod, id, 1, 'approved')).status).toBe(200)
    expect((await setState(mod, id, 2, 'pending')).status).toBe(200)
    await env.DB.prepare('UPDATE submission_tab SET external = NULL WHERE id = ?').bind(id).run()
    const res = await setState(mod, id, 3, 'approved')
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
    expect(gh.prs.size).toBe(1)
    expect((await json(res)).item.external.pr.number).toBe(41)
  })

  it('a failed approval keeps the stored PR number next to the new failure outcome', async () => {
    const { id } = await submit()
    const mod = await modCookie()
    expect((await setState(mod, id, 1, 'approved')).status).toBe(200)
    expect((await setState(mod, id, 2, 'pending')).status).toBe(200)
    await gh.setFile(PATH, 'something else entirely\n') // master's body changed -> base_conflict
    expect((await setState(mod, id, 3, 'approved')).status).toBe(409)
    const ext = await external(id)
    expect(ext.outcome.status).toBe('conflict')
    expect(ext.pr.number).toBe(41)
  })

  it('a failing token exchange -> 502 and the failure is not cached', async () => {
    const { id } = await submit()
    gh.failWhen = (m, p) => (p.includes('/access_tokens') ? 401 : null)
    const res = await setState(await modCookie(), id, 1, 'approved')
    expect(res.status).toBe(502)
    expect((await json(res)).error.message).not.toMatch(/BEGIN|eyJ/)
    expect(await env.KV.get('github:installation-token')).toBeNull()
  })

  it('a network error -> 502', async () => {
    const { id } = await submit()
    gh.failWhen = () => 0
    expect((await setState(await modCookie(), id, 1, 'approved')).status).toBe(502)
  })

  it('the installation token is cached in KV across approvals', async () => {
    const a = await submit('c1')
    const b = await submit('c2')
    const mod = await modCookie()
    expect((await setState(mod, a.id, 1, 'approved')).status).toBe(200)
    expect((await setState(mod, b.id, 1, 'approved')).status).toBe(200)
    expect(gh.tokenRequests()).toBe(1)
    expect(await env.KV.get('github:installation-token')).toBe('ghs_fake_installation_token')
  })

  it.each(['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_INSTALLATION_ID', 'GITHUB_REPO'])('missing %s -> 500 github_not_configured, still pending', async (name) => {
    await setup({ [name]: undefined })
    const { id } = await submit()
    const res = await setState(await modCookie(), id, 1, 'approved')
    expect(res.status).toBe(500)
    const err = (await json(res)).error
    expect(err.code).toBe('github_not_configured')
    expect(err.message).toContain(name)
    expect((await row(id)).state).toBe('pending')
    expect(gh.calls).toHaveLength(0)
  })

  it('an unusable private key -> 500 github_not_configured without echoing the key', async () => {
    await setup({ GITHUB_APP_PRIVATE_KEY: 'definitely-not-a-key-12345' })
    const { id } = await submit()
    const res = await setState(await modCookie(), id, 1, 'approved')
    expect(res.status).toBe(500)
    const err = (await json(res)).error
    expect(err.code).toBe('github_not_configured')
    expect(err.message).not.toContain('definitely-not-a-key-12345')
  })

  it('a PKCS#1 key gets a conversion hint', async () => {
    await setup({ GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----' })
    const { id } = await submit()
    const res = await setState(await modCookie(), id, 1, 'approved')
    expect((await json(res)).error.message).toContain('openssl pkcs8')
  })

  it('accepts a private key stored with literal \\n escapes', async () => {
    await setup({ GITHUB_APP_PRIVATE_KEY: pem.trim().replace(/\n/g, '\\n') })
    const { id } = await submit()
    expect((await setState(await modCookie(), id, 1, 'approved')).status).toBe(200)
  })
})

// ---------------------------------------------------------------------------------------------------------
// webhook
// ---------------------------------------------------------------------------------------------------------
async function sign(body: string, secret = SECRET) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))
  return 'sha256=' + [...sig].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function hook(payload: unknown, opts: { event?: string; signature?: string | null; secret?: string } = {}) {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const signature = opts.signature === undefined ? await sign(raw, opts.secret) : opts.signature
  return h.fetch('/api/webhooks/github', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': opts.event ?? 'pull_request', ...(signature ? { 'X-Hub-Signature-256': signature } : {}) },
    body: raw,
  })
}

const prEvent = (id: string, over: { action?: string; merged?: boolean; number?: number; ref?: string; headRepo?: string; repo?: string } = {}) => ({
  action: over.action ?? 'closed',
  number: over.number ?? 41,
  pull_request: { number: over.number ?? 41, merged: over.merged ?? false, html_url: 'https://github.com/org/wiki/pull/41', head: { ref: over.ref ?? `contrib/${id}`, repo: { full_name: over.headRepo ?? 'org/wiki' } } },
  repository: { full_name: over.repo ?? 'org/wiki' },
})

async function approvedWithPr() {
  const s = await submit()
  expect((await setState(await modCookie(), s.id, 1, 'approved')).status).toBe(200)
  return s
}

describe('GitHub webhook', () => {
  it('rejects a bad, missing or malformed signature and a missing secret; accepts the right one', async () => {
    const { id } = await approvedWithPr()
    const ev = prEvent(id, { merged: true })
    expect((await hook(ev, { secret: 'wrong' })).status).toBe(401)
    expect((await hook(ev, { signature: null })).status).toBe(401)
    expect((await hook(ev, { signature: 'sha256=' + 'zz'.repeat(32) })).status).toBe(401)
    expect((await hook(ev, { signature: 'sha256=abcd' })).status).toBe(401)
    expect((await hook(ev, { signature: (await sign(JSON.stringify(ev))).replace('sha256=', 'sha1=') })).status).toBe(401)
    expect((await external(id)).outcome.status).toBe('pr_open')
    expect((await hook(ev)).status).toBe(200)
    expect((await external(id)).outcome.status).toBe('merged')
    await setup({ GITHUB_WEBHOOK_SECRET: undefined })
    expect((await hook(ev, { secret: '' , signature: 'sha256=' + '00'.repeat(32) })).status).toBe(500)
  })

  it('a signature over a different body is rejected', async () => {
    const { id } = await approvedWithPr()
    const sig = await sign(JSON.stringify(prEvent(id, { merged: false })))
    expect((await hook(prEvent(id, { merged: true }), { signature: sig })).status).toBe(401)
  })

  it('merged: the owner sees status merged with the same URL; the PR info is kept; audited as github', async () => {
    const { id, token } = await approvedWithPr()
    const res = await hook(prEvent(id, { merged: true }))
    expect(res.status).toBe(200)
    expect((await mine(token))[0].outcome).toEqual({ status: 'merged', url: 'https://github.com/org/wiki/pull/41', label: 'Pull request #41 was merged' })
    expect((await external(id)).pr).toEqual({ number: 41, branch: `contrib/${id}`, url: 'https://github.com/org/wiki/pull/41' })
    const audit = await env.DB.prepare("SELECT * FROM audit_log_tab WHERE actor = 'github'").all<Record<string, unknown>>()
    expect(audit.results).toHaveLength(1)
    expect(audit.results[0]).toMatchObject({ action: 'submission.pr_merged', type: PAGE, target: id })
    expect(await row(id)).toMatchObject({ state: 'approved', version: 2 }) // moderators' version is not bumped
  })

  it('closed without merging: status closed', async () => {
    const { id, token } = await approvedWithPr()
    expect((await hook(prEvent(id, { merged: false }))).status).toBe(200)
    expect((await mine(token))[0].outcome).toEqual({ status: 'closed', url: 'https://github.com/org/wiki/pull/41', label: 'Pull request #41 was closed without merging' })
  })

  it('a reopened PR is open again', async () => {
    const { id, token } = await approvedWithPr()
    await hook(prEvent(id, { merged: false }))
    await hook(prEvent(id, { action: 'reopened' }))
    expect((await mine(token))[0].outcome).toMatchObject({ status: 'pr_open', url: 'https://github.com/org/wiki/pull/41' })
  })

  it('ignores other events and actions, other branches, other PR numbers, forks and other repositories', async () => {
    const { id } = await approvedWithPr()
    const unchanged = async (res: Response) => {
      expect(res.status).toBe(200)
      expect((await external(id)).outcome.status).toBe('pr_open')
    }
    await unchanged(await hook({ zen: 'hi' }, { event: 'ping' }))
    await unchanged(await hook(prEvent(id), { event: 'issues' }))
    await unchanged(await hook(prEvent(id, { action: 'opened' })))
    await unchanged(await hook(prEvent(id, { action: 'labeled' })))
    await unchanged(await hook(prEvent(id, { ref: 'feature/x' })))
    await unchanged(await hook(prEvent(id, { ref: `contrib/${id}/extra` })))
    await unchanged(await hook(prEvent('00000000-0000-0000-0000-000000000000', { merged: true })))
    await unchanged(await hook(prEvent(id, { number: 99, merged: true })))
    await unchanged(await hook(prEvent(id, { headRepo: 'attacker/wiki', merged: true })))
    await unchanged(await hook(prEvent(id, { repo: 'other/repo', headRepo: 'other/repo', merged: true })))
    await unchanged(await hook('{not json', { event: 'ping' }))
  })

  it('invalid JSON on a pull_request event is a 400 (after the signature check)', async () => {
    expect((await hook('{not json')).status).toBe(400)
  })

  it('does nothing for a submission that is not approved', async () => {
    const { id } = await approvedWithPr()
    const mod = await modCookie()
    await setState(mod, id, 2, 'pending')
    const before = await row(id)
    expect((await hook(prEvent(id, { merged: true }))).status).toBe(200)
    expect((await row(id)).external).toBe(before.external)
  })

  it('only POST is allowed', async () => {
    expect((await h.fetch('/api/webhooks/github')).status).toBe(404)
  })
})

describe('blob sha helper', () => {
  it('matches git (hash-object) for a known string', async () => {
    expect(await gitBlobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  })
})
