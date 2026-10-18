import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { writeAudit } from '../audit.ts'
import { getDb } from '../db/client.ts'
import { submission_tab } from '../db/schema.ts'
import { cleanOutcome, encodeExternal, parseExternal } from '../external.ts'
import { apiError, type AppEnv } from '../http.ts'

/** GitHub App webhook: keeps `submission_tab.external` in step with the pull request a moderator's approval opened. */
export const githubWebhookRoutes = new Hono<AppEnv>()

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024
const BRANCH_RE = /^contrib\/([A-Za-z0-9-]{1,64})$/

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** `X-Hub-Signature-256` check: HMAC-SHA256 of the raw body, compared in constant time by WebCrypto. */
export async function verifyGithubSignature(secret: string, rawBody: string, header: string | undefined): Promise<boolean> {
  if (!secret || !header?.startsWith('sha256=')) return false
  const sig = hexToBytes(header.slice('sha256='.length))
  if (!sig || sig.length !== 32) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  return crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(rawBody))
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)

githubWebhookRoutes.post('/', async (c) => {
  const secret = c.env.GITHUB_WEBHOOK_SECRET
  if (!secret) return apiError(c, 500, 'webhook_not_configured', 'The GitHub webhook secret is not set.')
  if (Number(c.req.header('Content-Length') ?? '0') > MAX_WEBHOOK_BYTES) return apiError(c, 413, 'too_large', 'Request body too large.')
  const raw = await c.req.text()
  if (!(await verifyGithubSignature(secret, raw, c.req.header('X-Hub-Signature-256')))) return apiError(c, 401, 'bad_signature', 'Invalid signature.')

  const event = c.req.header('X-GitHub-Event')
  if (event !== 'pull_request') return c.json({ ok: true, ignored: event ?? 'unknown' })

  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return apiError(c, 400, 'bad_json', 'Invalid JSON body.')
  }
  if (!isObj(payload) || !isObj(payload.pull_request) || (payload.action !== 'closed' && payload.action !== 'reopened')) return c.json({ ok: true, ignored: 'action' })
  const pr = payload.pull_request
  const branch = BRANCH_RE.exec(String(pr.head?.ref ?? ''))
  // Only branches of the repository itself: a fork can name its branch contrib/<id> too.
  const repoName = payload.repository?.full_name
  if (!branch || typeof pr.number !== 'number' || (pr.head?.repo?.full_name !== undefined && pr.head.repo.full_name !== repoName)) return c.json({ ok: true, ignored: 'branch' })
  if (c.env.GITHUB_REPO && repoName !== c.env.GITHUB_REPO) return c.json({ ok: true, ignored: 'repository' })

  const db = getDb(c.env)
  const row = await db
    .select()
    .from(submission_tab)
    .where(and(eq(submission_tab.id, branch[1]), eq(submission_tab.state, 'approved')))
    .get()
  const external = row ? parseExternal(row.external) : null
  const known = (external?.pr as { number?: unknown } | undefined)?.number
  if (!row || !external || known !== pr.number) return c.json({ ok: true, ignored: 'submission' })

  const url = cleanOutcome({ status: 'x', url: (external.pr as { url?: unknown }).url })?.url ?? external.outcome?.url
  const outcome =
    payload.action === 'reopened'
      ? { status: 'pr_open', label: `Pull request #${pr.number} is open for review` }
      : pr.merged === true
        ? { status: 'merged', label: `Pull request #${pr.number} was merged` }
        : { status: 'closed', label: `Pull request #${pr.number} was closed without merging` }
  const stored = encodeExternal({ ...external, outcome: { ...outcome, ...(url ? { url } : {}) } })
  if (!stored.ok) return apiError(c, 500, 'bad_external', stored.message)

  const now = c.get('deps').now()
  await db.update(submission_tab).set({ external: stored.json, externalAt: now }).where(eq(submission_tab.id, row.id)).run()
  await writeAudit(db, { actor: 'github', action: `submission.pr_${outcome.status}`, type: row.type, target: row.id, detail: { pr: pr.number } }, now)
  return c.json({ ok: true, outcome: outcome.status })
})
