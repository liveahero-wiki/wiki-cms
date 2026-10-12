import { eq } from 'drizzle-orm'
import { getDb } from './db/client.ts'
import { submission_type_tab } from './db/schema.ts'
import type { SubmissionTypeDef } from './types-registry.ts'
import { TYPE_DEFS } from '../types/index.ts'
import type { Env } from '../env.ts'

export interface ResolvedType {
  def: SubmissionTypeDef
  name: string
  allowedOrigins: string[]
  pluginUrl: string
  groupsUrl: string
  /** Secret: never return this from an API or log it. */
  discordWebhookUrl: string | null
  discordThreadId: string | null
  webhookPerHour: number
}

const TTL_MS = 60_000
let cache: { at: number; rows: Map<string, ResolvedType | null> } = { at: 0, rows: new Map() }

export function clearTypeCache(): void {
  cache = { at: 0, rows: new Map() }
}

const defById = (id: string) => TYPE_DEFS.find((d) => d.id === id)

function parseOrigins(json: string): string[] {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Resolved type = code def joined with an *enabled* D1 config row; null if either is missing. 60 s memo. */
export async function getType(env: Env, id: string, now = Date.now()): Promise<ResolvedType | null> {
  if (now - cache.at > TTL_MS) cache = { at: now, rows: new Map() }
  if (cache.rows.has(id)) return cache.rows.get(id)!
  const def = defById(id)
  let resolved: ResolvedType | null = null
  if (def) {
    const row = await getDb(env).select().from(submission_type_tab).where(eq(submission_type_tab.id, id)).get()
    if (row && row.enabled) {
      resolved = {
        def,
        name: row.name,
        allowedOrigins: parseOrigins(row.allowedOrigins),
        pluginUrl: row.pluginUrl,
        groupsUrl: row.groupsUrl,
        discordWebhookUrl: row.discordWebhookUrl,
        discordThreadId: row.discordThreadId,
        webhookPerHour: row.webhookPerHour,
      }
    }
  }
  cache.rows.set(id, resolved)
  return resolved
}

/** All enabled, code-backed types (used by housekeeping). Bypasses the memo. */
export async function listEnabledTypes(env: Env): Promise<{ id: string; resolved: ResolvedType }[]> {
  const rows = await getDb(env).select().from(submission_type_tab).where(eq(submission_type_tab.enabled, 1)).all()
  const out: { id: string; resolved: ResolvedType }[] = []
  for (const row of rows) {
    const def = defById(row.id)
    if (!def) continue
    out.push({
      id: row.id,
      resolved: {
        def,
        name: row.name,
        allowedOrigins: parseOrigins(row.allowedOrigins),
        pluginUrl: row.pluginUrl,
        groupsUrl: row.groupsUrl,
        discordWebhookUrl: row.discordWebhookUrl,
        discordThreadId: row.discordThreadId,
        webhookPerHour: row.webhookPerHour,
      },
    })
  }
  return out
}
