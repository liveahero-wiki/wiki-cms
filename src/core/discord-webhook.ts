// Pure helpers (no env imports: also used by the CLI under Node type stripping).

/** Only genuine Discord webhook endpoints are accepted, so the Worker can't be pointed at an arbitrary host. */
export function isDiscordWebhookUrl(value: string): boolean {
  let u: URL
  try {
    u = new URL(value)
  } catch {
    return false
  }
  return (
    u.protocol === 'https:' &&
    (u.hostname === 'discord.com' || u.hostname === 'discordapp.com') &&
    /^\/api\/webhooks\/\d+\/[\w-]+$/.test(u.pathname) &&
    !u.search &&
    !u.hash
  )
}

export const isDiscordThreadId = (value: string): boolean => /^\d{1,30}$/.test(value)

/** Webhook execute URL: `wait=false` (we don't need the message back) and an optional thread. */
export function webhookExecuteUrl(webhookUrl: string, threadId: string | null): string {
  const u = new URL(webhookUrl)
  u.searchParams.set('wait', 'false')
  if (threadId) u.searchParams.set('thread_id', threadId)
  return u.toString()
}
