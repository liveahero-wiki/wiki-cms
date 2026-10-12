import { describe, expect, it } from 'vitest'
import { isDiscordThreadId, isDiscordWebhookUrl, webhookExecuteUrl } from './discord-webhook.ts'

const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abc-DEF_123'

describe('isDiscordWebhookUrl', () => {
  it('accepts discord.com and discordapp.com webhook URLs', () => {
    expect(isDiscordWebhookUrl(HOOK)).toBe(true)
    expect(isDiscordWebhookUrl(HOOK.replace('discord.com', 'discordapp.com'))).toBe(true)
  })

  it('rejects other hosts, schemes, paths and extras', () => {
    for (const bad of [
      'http://discord.com/api/webhooks/1/x',
      'https://discord.com.evil.example/api/webhooks/1/x',
      'https://evil.example/api/webhooks/1/x',
      'https://discord.com/api/webhooks/abc/x',
      'https://discord.com/api/webhooks/1/x/extra',
      `${HOOK}?thread_id=1`,
      `${HOOK}#x`,
      'not a url',
      '',
    ]) {
      expect(isDiscordWebhookUrl(bad), bad).toBe(false)
    }
  })
})

describe('isDiscordThreadId', () => {
  it('accepts numeric ids only', () => {
    expect(isDiscordThreadId('1559173832760361062')).toBe(true)
    expect(isDiscordThreadId('12a')).toBe(false)
    expect(isDiscordThreadId('')).toBe(false)
  })
})

describe('webhookExecuteUrl', () => {
  it('adds wait=false and the thread id', () => {
    const u = new URL(webhookExecuteUrl(HOOK, '42'))
    expect(u.searchParams.get('wait')).toBe('false')
    expect(u.searchParams.get('thread_id')).toBe('42')
    expect(new URL(webhookExecuteUrl(HOOK, null)).searchParams.has('thread_id')).toBe(false)
  })
})
