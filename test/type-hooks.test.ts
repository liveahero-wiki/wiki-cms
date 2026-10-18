import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { ApproveResult, HookRow, SubmissionTypeDef, ValidateResult } from '../src/core/types-registry.ts'
import { TYPE_DEFS } from '../src/types/index.ts'
import { contribApi, contribLogin, makeHarness, resetState, rows, seedType, sessionCookie, type Harness } from './helpers.ts'

// Test-only types exercising the generic per-type hooks of the core (own body cap, approval hook), independent of any real type.
interface P {
  n: string
}
const validate = (input: unknown): ValidateResult<P> =>
  typeof input === 'object' && input !== null && typeof (input as P).n === 'string'
    ? { ok: true, value: { n: (input as P).n } }
    : { ok: false, errors: [{ path: 'payload.n', code: 'n_invalid', message: 'n must be text' }] }

const base = { langs: [{ value: 'en', label: 'English' }], tags: [], accountOnly: true, validatePayload: validate } satisfies Partial<SubmissionTypeDef<P>>

let hookCalls: { row: HookRow; now: number }[] = []
let hookResult: () => ApproveResult | Promise<ApproveResult> = () => ({ ok: true })

const BIG = 'test-big'
const HOOK = 'test-hook'
const defs: SubmissionTypeDef<P>[] = [
  { ...base, id: BIG, maxPayloadBytes: 150 * 1024, maxBodyBytes: 160 * 1024 },
  {
    ...base,
    id: HOOK,
    maxPayloadBytes: 1000,
    async onApprove(_env, row, now) {
      hookCalls.push({ row, now })
      return hookResult()
    },
  },
]

beforeAll(() => void TYPE_DEFS.push(...defs))
afterAll(() => {
  for (const d of defs) TYPE_DEFS.splice(TYPE_DEFS.indexOf(d), 1)
})

let h: Harness
let clock = Date.now()
const json = async <T = any>(r: Response) => (await r.json()) as T

beforeEach(async () => {
  await resetState()
  clock = Date.now()
  hookCalls = []
  hookResult = () => ({ ok: true })
  h = makeHarness({ now: () => clock })
  await seedType(BIG)
  await seedType(HOOK)
})

let ipSeq = 0
const submit = (token: string | null, type: string, n: string) =>
  contribApi(h, token, 'POST', `/submissions/${type}/all`, { payload: { n }, tags: {}, lang: 'en', turnstileToken: 'tok', website: '' }, { 'CF-Connecting-IP': `203.0.113.${100 + (ipSeq++ % 100)}` })

const admin = (cookie: string, method: string, path: string, b?: unknown) =>
  h.fetch(`/api/admin${path}`, {
    method,
    headers: { Cookie: cookie, Origin: 'http://localhost:8787', ...(b !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(b !== undefined ? { body: JSON.stringify(b) } : {}),
  })
const setState = (mod: string, id: string, state: string, expectedVersion = 1) => admin(mod, 'POST', `/submissions/${id}/state`, { expectedVersion, state })

describe('per-type body cap (maxBodyBytes)', () => {
  it('a type may take a body over the 32 KB default, up to its own cap', async () => {
    const token = await contribLogin('c1', { displayName: 'Alice' })
    const mid = await submit(token, BIG, 'x'.repeat(100 * 1024))
    expect(mid.status, JSON.stringify(await mid.clone().json())).toBe(202)
    const over = await submit(token, BIG, 'x'.repeat(161 * 1024))
    expect(over.status).toBe(413)
    expect((await json(over)).error.code).toBe('too_large')
  })

  it('the cap is also bounded by maxPayloadBytes', async () => {
    const token = await contribLogin('c1')
    const res = await submit(token, BIG, 'x'.repeat(155 * 1024))
    expect(res.status).toBe(400)
    expect((await json(res)).error.fields[0].code).toBe('payload_too_large')
  })

  it('a type without maxBodyBytes keeps the 32 KB cap', async () => {
    const token = await contribLogin('c1')
    expect((await submit(token, HOOK, 'x'.repeat(40 * 1024))).status).toBe(413)
  })
})

describe('onApprove hook', () => {
  const setup = async () => {
    const token = await contribLogin('c1', { displayName: 'Alice' })
    const { id } = await json(await submit(token, HOOK, 'hello'))
    const mod = await sessionCookie('mod', { types: [HOOK] })
    return { token, id, mod }
  }

  it('success: the row is approved and the returned external is stored; the hook sees the row, the owner and the clock', async () => {
    const { token, id, mod } = await setup()
    hookResult = () => ({ ok: true, external: { outcome: { status: 'pr_open', url: 'https://github.com/o/r/pull/1', label: 'PR #1' }, pr: { number: 1, branch: 'b' } } })
    const res = await setState(mod, id, 'approved')
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
    expect((await json(res)).item).toMatchObject({ state: 'approved', version: 2, external: { outcome: { status: 'pr_open' }, pr: { number: 1 } }, externalAt: clock })
    expect(hookCalls).toHaveLength(1)
    expect(hookCalls[0]).toMatchObject({ now: clock, row: { id, type: HOOK, groupId: 'all', version: 1, lang: 'en', payload: { n: 'hello' }, external: null, owner: { id: 'c1', displayName: 'Alice' } } })
    const mine = await json(await contribApi(h, token, 'GET', `/submissions?type=${HOOK}`))
    expect(mine.items[0].outcome).toEqual({ status: 'pr_open', url: 'https://github.com/o/r/pull/1', label: 'PR #1' })
    expect(JSON.stringify(mine)).not.toContain('branch') // only the outcome reaches the owner
  })

  it('success without an external leaves it null', async () => {
    const { id, mod } = await setup()
    expect((await setState(mod, id, 'approved')).status).toBe(200)
    expect((await rows(`id='${id}'`))[0]).toMatchObject({ state: 'approved', external: null })
  })

  it('failure: the row stays pending (same version), the failure is stored, the error status and code are returned', async () => {
    const { token, id, mod } = await setup()
    hookResult = () => ({ ok: false, status: 502, code: 'github_unavailable', message: 'GitHub said no.', external: { outcome: { status: 'error', label: 'GitHub said no.' } } })
    const res = await setState(mod, id, 'approved')
    expect(res.status).toBe(502)
    expect((await json(res)).error).toMatchObject({ code: 'github_unavailable', message: 'GitHub said no.' })
    const [row] = await rows(`id='${id}'`)
    expect(row).toMatchObject({ state: 'pending', version: 1, external_at: clock })
    expect(JSON.parse(row!.external as string)).toEqual({ outcome: { status: 'error', label: 'GitHub said no.' } })
    expect((await json(await contribApi(h, token, 'GET', `/submissions?type=${HOOK}`))).items[0].outcome.status).toBe('error')

    // The moderator retries after the cause is fixed: success replaces the stored failure and the hook sees it.
    hookResult = () => ({ ok: true, external: { outcome: { status: 'pr_open' } } })
    const retry = await setState(mod, id, 'approved')
    expect(retry.status).toBe(200)
    expect(hookCalls[1]!.row.external).toEqual({ outcome: { status: 'error', label: 'GitHub said no.' } })
    expect((await json(retry)).item).toMatchObject({ state: 'approved', version: 2, external: { outcome: { status: 'pr_open' } } })
  })

  it('failure without an external changes nothing; 409 and 400 statuses pass through', async () => {
    const { id, mod } = await setup()
    hookResult = () => ({ ok: false, status: 409, code: 'conflict', message: 'The page changed.' })
    const res = await setState(mod, id, 'approved')
    expect(res.status).toBe(409)
    expect((await json(res)).error.code).toBe('conflict')
    expect((await rows(`id='${id}'`))[0]).toMatchObject({ state: 'pending', version: 1, external: null, external_at: null })
    hookResult = () => ({ ok: false, status: 400, code: 'bad', message: 'Bad.' })
    expect((await setState(mod, id, 'approved')).status).toBe(400)
  })

  it('an unusable external from the hook is a 500 and nothing is approved', async () => {
    const { id, mod } = await setup()
    hookResult = () => ({ ok: true, external: 'not an object' })
    const res = await setState(mod, id, 'approved')
    expect(res.status).toBe(500)
    expect((await json(res)).error.code).toBe('bad_external')
    expect((await rows(`id='${id}'`))[0]).toMatchObject({ state: 'pending', version: 1, external: null })
  })

  it('is only called when approving: not for spam, not when the state does not change, not for a stale version', async () => {
    const { id, mod } = await setup()
    expect((await setState(mod, id, 'spam')).status).toBe(200)
    expect((await setState(mod, id, 'spam', 2)).status).toBe(200) // unchanged
    expect((await setState(mod, id, 'approved', 1)).status).toBe(409) // stale
    expect(hookCalls).toHaveLength(0)
    expect((await setState(mod, id, 'approved', 2)).status).toBe(200) // spam -> approved runs it
    expect(hookCalls).toHaveLength(1)
    expect((await setState(mod, id, 'approved', 3)).status).toBe(200) // already approved
    expect(hookCalls).toHaveLength(1)
  })

  it('bulk approval is refused for such a type, while other bulk changes still work', async () => {
    const { id, mod } = await setup()
    const token = await contribLogin('c2')
    const plain = (await json(await submit(token, BIG, 'plain'))).id
    const modAll = await sessionCookie('mod2', { types: [HOOK, BIG] })
    const refused = await admin(modAll, 'POST', '/submissions/bulk-state', { ids: [id, plain], state: 'approved' })
    expect(refused.status).toBe(400)
    expect((await json(refused)).error.code).toBe('bulk_not_allowed')
    expect((await rows()).map((r) => r.state)).toEqual(['pending', 'pending']) // nothing was changed
    expect(hookCalls).toHaveLength(0)
    // Types without the hook can still be approved in bulk, and the hook type can be marked as spam in bulk.
    expect((await admin(modAll, 'POST', '/submissions/bulk-state', { ids: [plain], state: 'approved' })).status).toBe(200)
    expect((await admin(mod, 'POST', '/submissions/bulk-state', { ids: [id], state: 'spam' })).status).toBe(200)
  })
})
