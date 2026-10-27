import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearTypeCache } from '../src/core/types-runtime.ts'
import { discordCalls, discordStatus, makeHarness, post, resetState, submitBody, TYPE } from './helpers.ts'

// Fake webhook (not a real one).
const HOOK = 'https://discord.com/api/webhooks/123456789012345678/test-token_abc'

async function configure(cols: { hook?: string | null; thread?: string | null; perHour?: number } = {}) {
  await env.DB.prepare('UPDATE submission_type_tab SET discord_webhook_url = ?, discord_thread_id = ?, webhook_per_hour = ? WHERE id = ?')
    .bind(cols.hook === undefined ? HOOK : cols.hook, cols.thread === undefined ? '555' : cols.thread, cols.perHour ?? 10, TYPE)
    .run()
  clearTypeCache()
}

/** Submit from a distinct IP so the per-IP daily cap doesn't interfere. */
const submit = (h: ReturnType<typeof makeHarness>, i: number, group = 'quest-1') =>
  post(h, group, submitBody({ explanation: `team ${i}` }), { 'CF-Connecting-IP': `203.0.113.${i + 1}` })

beforeEach(() => resetState())

describe('Discord notification', () => {
  it('posts a link to the type page into the configured thread', async () => {
    await configure()
    const h = makeHarness()
    expect((await submit(h, 1)).status).toBe(202)
    await h.settle()
    expect(discordCalls).toHaveLength(1)
    const u = new URL(discordCalls[0]!.url)
    expect(u.pathname).toBe('/api/webhooks/123456789012345678/test-token_abc')
    expect(u.searchParams.get('thread_id')).toBe('555')
    expect(u.searchParams.get('wait')).toBe('false')
    const { content, allowed_mentions } = discordCalls[0]!.body
    expect(content).toContain('/t/lah-team-formation')
    expect(content).not.toContain('/g/') // the admin has no group pages
    expect(content).toContain('1 pending')
    expect(content).not.toContain('team 1') // user-supplied text is never forwarded
    expect(allowed_mentions).toEqual({ parse: [] })
  })

  it('omits thread_id when none is configured', async () => {
    await configure({ thread: null })
    const h = makeHarness()
    await submit(h, 1)
    await h.settle()
    expect(new URL(discordCalls[0]!.url).searchParams.has('thread_id')).toBe(false)
  })

  it('does nothing when no webhook is configured', async () => {
    const h = makeHarness()
    expect((await submit(h, 1)).status).toBe(202)
    await h.settle()
    expect(discordCalls).toHaveLength(0)
  })

  it('does nothing for rejected submissions and honeypot hits', async () => {
    await configure()
    const h = makeHarness()
    expect((await post(h, 'quest-1', submitBody({ lang: 'xx' }))).status).toBe(400)
    expect((await post(h, 'quest-1', submitBody({ website: 'spam' }))).status).toBe(202)
    await h.settle()
    expect(discordCalls).toHaveLength(0)
  })

  it('refuses a non-Discord URL stored in D1', async () => {
    await configure({ hook: 'https://discord.com.evil.example/api/webhooks/1/x' })
    const h = makeHarness()
    await submit(h, 1)
    await h.settle()
    expect(discordCalls).toHaveLength(0)
  })

  it('caps notifications per hour and starts a new window afterwards', async () => {
    await configure({ perHour: 3 })
    let t = 1_000_000_000_000
    const h = makeHarness({ now: () => t })
    for (let i = 1; i <= 5; i++) {
      expect((await submit(h, i)).status).toBe(202)
      t += 60_000
    }
    await h.settle()
    expect(discordCalls).toHaveLength(3)
    t += 60 * 60_000
    await submit(h, 6)
    await h.settle()
    expect(discordCalls).toHaveLength(4)
  })

  it('defaults to 10 per hour', async () => {
    await configure()
    const h = makeHarness({ now: () => 1_000_000_000_000 })
    for (let i = 1; i <= 12; i++) await submit(h, i)
    await h.settle()
    expect(discordCalls).toHaveLength(10)
  })

  it.each([500, 0])('Discord failure (status %i) never affects the submission', async (status) => {
    await configure()
    discordStatus.value = status
    const h = makeHarness()
    const res = await submit(h, 1)
    await h.settle()
    expect(res.status).toBe(202)
    expect(discordCalls).toHaveLength(1)
  })

  it('never exposes the webhook URL through public APIs', async () => {
    await configure()
    const h = makeHarness()
    const res = await h.fetch(`/api/v1/types/${TYPE}`)
    expect(await res.text()).not.toContain('webhooks')
  })
})
