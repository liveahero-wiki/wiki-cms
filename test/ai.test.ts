import { beforeEach, describe, expect, it } from 'vitest'
import { parseAiVerdict } from '../src/core/ai-moderation.ts'
import { makeHarness, post, resetState, rows, submitBody } from './helpers.ts'

beforeEach(() => resetState())

const fakeAi = (response: unknown) => ({ run: async () => ({ response }) })

describe('parseAiVerdict', () => {
  it('parses strict JSON, fenced JSON and rejects junk', () => {
    expect(parseAiVerdict('{"spam":false,"abusive":false,"reason":"fine"}')).toEqual({ verdict: 'ok', reason: 'fine' })
    expect(parseAiVerdict('```json\n{"spam":true,"abusive":false,"reason":"ads"}\n```').verdict).toBe('spam')
    expect(parseAiVerdict('{"spam":false,"abusive":true,"reason":"slur"}').verdict).toBe('abusive')
    expect(parseAiVerdict('sure!').verdict).toBe('error')
    expect(parseAiVerdict('{"spam":"maybe"}').verdict).toBe('error')
    expect(parseAiVerdict(undefined).verdict).toBe('error')
  })
})

describe('AI moderation', () => {
  it('off: nothing is classified', async () => {
    const h = makeHarness({}, { AI: fakeAi('{"spam":true,"abusive":false,"reason":"x"}'), AI_MODERATION: 'off' })
    await post(h, 'quest-1', submitBody())
    await h.settle()
    expect((await rows())[0]).toMatchObject({ state: 'pending', ai_verdict: null })
  })

  it('flag: stores the verdict but leaves the row pending', async () => {
    const h = makeHarness({}, { AI: fakeAi('{"spam":true,"abusive":false,"reason":"ads"}'), AI_MODERATION: 'flag' })
    await post(h, 'quest-1', submitBody())
    await h.settle()
    expect((await rows())[0]).toMatchObject({ state: 'pending', ai_verdict: 'spam', ai_reason: 'ads' })
  })

  it('auto: spam goes to the spam state with an audit row', async () => {
    const h = makeHarness({}, { AI: fakeAi('{"spam":true,"abusive":false,"reason":"ads"}'), AI_MODERATION: 'auto' })
    await post(h, 'quest-1', submitBody())
    await h.settle()
    expect((await rows())[0]).toMatchObject({ state: 'spam', ai_verdict: 'spam', version: 2 })
    const audit = await (await import('cloudflare:workers')).env.DB.prepare("SELECT action, actor FROM audit_log_tab").all()
    expect(audit.results).toEqual([{ action: 'system.ai_spam', actor: 'system' }])
  })

  it('auto: ok verdicts stay pending; AI errors never block the submission', async () => {
    const ok = makeHarness({}, { AI: fakeAi('{"spam":false,"abusive":false,"reason":"fine"}'), AI_MODERATION: 'auto' })
    expect((await post(ok, 'quest-1', submitBody())).status).toBe(202)
    await ok.settle()
    const broken = makeHarness({}, { AI: { run: async () => { throw new Error('quota') } }, AI_MODERATION: 'auto' })
    expect((await post(broken, 'quest-1', submitBody({ explanation: 'other' }), { 'CF-Connecting-IP': '203.0.113.99' })).status).toBe(202)
    await broken.settle()
    const r = await rows()
    expect(r.map((x) => [x.state, x.ai_verdict])).toEqual([['pending', 'ok'], ['pending', 'error']])
  })
})
