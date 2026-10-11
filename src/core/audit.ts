import { audit_log_tab } from './db/schema.ts'
import type { Db } from './db/client.ts'

export interface AuditEntry {
  actor: string
  action: string
  type?: string | null
  target?: string | null
  detail?: unknown
}

export async function writeAudit(db: Db, entry: AuditEntry, now = Date.now()): Promise<void> {
  await db.insert(audit_log_tab).values({
    at: now,
    actor: entry.actor,
    action: entry.action,
    type: entry.type ?? null,
    target: entry.target ?? null,
    detail: entry.detail === undefined ? null : JSON.stringify(entry.detail),
  })
}
