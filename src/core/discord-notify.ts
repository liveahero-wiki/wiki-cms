import { and, eq, or, sql } from 'drizzle-orm'
import { HOUR_MS } from '../config.ts'
import type { Env } from '../env.ts'
import { getDb } from './db/client.ts'
import { submission_type_tab } from './db/schema.ts'
import { isDiscordWebhookUrl, webhookExecuteUrl } from './discord-webhook.ts'
import type { ResolvedType } from './types-runtime.ts'

/**
 * Claims one notification slot in the current fixed one-hour window (window starts at the first message).
 * A single conditional UPDATE keeps this atomic across isolates; the slot is claimed before the fetch so
 * a failing Discord cannot cause retries.
 */
async function claimSlot(env: Env, typeId: string, limit: number, now: number): Promise<boolean> {
  const t = submission_type_tab
  const expired = sql`${t.webhookWindowStart} <= ${now - HOUR_MS}`
  const r = await getDb(env)
    .update(t)
    .set({
      webhookWindowStart: sql`CASE WHEN ${expired} THEN ${now} ELSE ${t.webhookWindowStart} END`,
      webhookWindowCount: sql`CASE WHEN ${expired} THEN 1 ELSE ${t.webhookWindowCount} + 1 END`,
    })
    .where(and(eq(t.id, typeId), or(expired, sql`${t.webhookWindowCount} < ${limit}`)))
    .run()
  return (r.meta.changes ?? 0) > 0
}

/**
 * Best-effort "new submission awaiting moderation" message. Never throws and never logs the webhook URL.
 * Only metadata is sent (no user-supplied text) and mentions are disabled.
 */
export async function notifyNewSubmission(
  env: Env,
  rt: ResolvedType,
  typeId: string,
  group: { id: string; title: string },
  pendingCount: number,
  now: number,
): Promise<void> {
  const hook = rt.discordWebhookUrl
  if (!hook) return
  try {
    if (!isDiscordWebhookUrl(hook)) return
    if (!(await claimSlot(env, typeId, rt.webhookPerHour, now))) return
    const link = `${env.PUBLIC_URL.replace(/\/$/, '')}/t/${encodeURIComponent(typeId)}/g/${encodeURIComponent(group.id)}`
    const res = await fetch(webhookExecuteUrl(hook, rt.discordThreadId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `New **${rt.name}** submission for **${group.title}** is waiting for review (${pendingCount} pending): ${link}`,
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) {
      // Discord's error JSON ({ message, code }) never echoes the webhook token; cap it anyway.
      const detail = (await res.text().catch(() => '')).slice(0, 200)
      console.warn('discord notify: webhook returned', res.status, detail)
    }
  } catch {
    console.warn('discord notify: failed')
  }
}
