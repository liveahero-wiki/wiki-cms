import { and, eq, isNotNull, lt, notExists, sql } from 'drizzle-orm'
import { AUDIT_RETENTION_DAYS, DAY_MS, INVITE_PURGE_AFTER_DAYS, IP_RETENTION_DAYS, ORPHAN_USER_AFTER_MS, SPAM_RETENTION_DAYS } from '../config.ts'
import type { Env } from '../env.ts'
import { writeAudit } from './audit.ts'
import type { Purger } from './cache.ts'
import { getDb } from './db/client.ts'
import { audit_log_tab, invite_tab, moderator_permission_tab, session_tab, submission_tab, user_tab, verification_tab } from './db/schema.ts'
import { refreshGroups, refreshRoster } from './groups.ts'
import { republishMany } from './publish.ts'
import { listEnabledTypes } from './types-runtime.ts'

export interface HousekeepingResult {
  spamDeleted: number
  auditDeleted: number
  invitesDeleted: number
  sessionsDeleted: number
  verificationsDeleted: number
  usersDeleted: number
  ipsCleared: number
  groupsRepublished: number
}

/** Hourly housekeeping (single cron trigger). Individual deletions are not audited; one summary row when anything was deleted. */
export async function runHousekeeping(env: Env, purge: Purger, now = Date.now()): Promise<HousekeepingResult> {
  const db = getDb(env)
  const changes = (r: { meta: { changes?: number } }) => r.meta.changes ?? 0

  const spamDeleted = changes(
    await db.delete(submission_tab).where(and(eq(submission_tab.state, 'spam'), lt(submission_tab.stateChangedAt, now - SPAM_RETENTION_DAYS * DAY_MS))).run(),
  )
  const auditDeleted = changes(await db.delete(audit_log_tab).where(lt(audit_log_tab.at, now - AUDIT_RETENTION_DAYS * DAY_MS)).run())
  const invitesDeleted = changes(await db.delete(invite_tab).where(lt(invite_tab.expiresAt, now - INVITE_PURGE_AFTER_DAYS * DAY_MS)).run())
  const sessionsDeleted = changes(await db.delete(session_tab).where(lt(session_tab.expiresAt, new Date(now))).run())
  const verificationsDeleted = changes(await db.delete(verification_tab).where(lt(verification_tab.expiresAt, new Date(now))).run())

  // Orphan users: no permission rows and no claimed invite, older than 24 h (cascades to sessions/accounts).
  const usersDeleted = changes(
    await db
      .delete(user_tab)
      .where(
        and(
          lt(user_tab.createdAt, new Date(now - ORPHAN_USER_AFTER_MS)),
          notExists(db.select({ x: sql`1` }).from(moderator_permission_tab).where(eq(moderator_permission_tab.userId, user_tab.id))),
          notExists(db.select({ x: sql`1` }).from(invite_tab).where(eq(invite_tab.usedBy, user_tab.id))),
        ),
      )
      .run(),
  )

  // Privacy: null the raw IP after the retention window (ip_key and country stay).
  const ipsCleared = changes(
    await db.update(submission_tab).set({ ip: null }).where(and(isNotNull(submission_tab.ip), lt(submission_tab.createdAt, now - IP_RETENTION_DAYS * DAY_MS))).run(),
  )

  // Registry + roster refresh per type; republish groups whose options changed.
  let groupsRepublished = 0
  for (const { id, resolved } of await listEnabledTypes(env)) {
    try {
      const r = await refreshGroups(env, id, resolved, now)
      await refreshRoster(env, id, resolved, now)
      if (r.optionsChanged.length) {
        await republishMany(env, id, resolved, r.optionsChanged, purge)
        groupsRepublished += r.optionsChanged.length
      }
    } catch (e) {
      console.error('housekeeping: registry refresh failed for', id, e)
    }
  }

  const result = { spamDeleted, auditDeleted, invitesDeleted, sessionsDeleted, verificationsDeleted, usersDeleted, ipsCleared, groupsRepublished }
  if (spamDeleted + auditDeleted + invitesDeleted + sessionsDeleted + verificationsDeleted + usersDeleted + ipsCleared + groupsRepublished > 0) {
    await writeAudit(db, { actor: 'system', action: 'system.housekeeping', detail: result }, now)
  }
  return result
}

