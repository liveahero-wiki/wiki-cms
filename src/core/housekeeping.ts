import { and, eq, gt, isNotNull, lt, notExists, sql } from 'drizzle-orm'
import { AUDIT_RETENTION_DAYS, CONTRIB_IDLE_PRUNE_DAYS, DAY_MS, INVITE_PURGE_AFTER_DAYS, IP_RETENTION_DAYS, ORPHAN_USER_AFTER_MS, SPAM_RETENTION_DAYS } from '../config.ts'
import type { Env } from '../env.ts'
import { writeAudit } from './audit.ts'
import type { Purger } from './cache.ts'
import { getDb } from './db/client.ts'
import { audit_log_tab, contrib_token_tab, contributor_tab, invite_tab, moderator_permission_tab, oauth_state_tab, session_tab, submission_tab, user_tab, verification_tab } from './db/schema.ts'
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
  tokensDeleted: number
  oauthStatesDeleted: number
  contributorsPruned: number
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

  // Expired contributor tokens.
  const tokensDeleted = changes(await db.delete(contrib_token_tab).where(lt(contrib_token_tab.expiresAt, now)).run())

  // Expired Bluesky authorization requests.
  const oauthStatesDeleted = changes(await db.delete(oauth_state_tab).where(lt(oauth_state_tab.expiresAt, now)).run())

  // Idle contributor accounts: no submissions, no live token, no recent token use (their user row goes via the orphan rule below).
  const idleBefore = now - CONTRIB_IDLE_PRUNE_DAYS * DAY_MS
  const contributorsPruned = changes(
    await db
      .delete(contributor_tab)
      .where(
        and(
          lt(contributor_tab.createdAt, idleBefore),
          notExists(db.select({ x: sql`1` }).from(submission_tab).where(eq(submission_tab.userId, contributor_tab.userId))),
          notExists(db.select({ x: sql`1` }).from(contrib_token_tab).where(and(eq(contrib_token_tab.userId, contributor_tab.userId), gt(contrib_token_tab.lastUsedAt, idleBefore)))),
        ),
      )
      .run(),
  )

  // Orphan users: no permission rows, no claimed invite, no contributor profile and no submissions, older than 24 h (cascades to sessions/accounts).
  const usersDeleted = changes(
    await db
      .delete(user_tab)
      .where(
        and(
          lt(user_tab.createdAt, new Date(now - ORPHAN_USER_AFTER_MS)),
          notExists(db.select({ x: sql`1` }).from(moderator_permission_tab).where(eq(moderator_permission_tab.userId, user_tab.id))),
          notExists(db.select({ x: sql`1` }).from(invite_tab).where(eq(invite_tab.usedBy, user_tab.id))),
          notExists(db.select({ x: sql`1` }).from(contributor_tab).where(eq(contributor_tab.userId, user_tab.id))),
          notExists(db.select({ x: sql`1` }).from(submission_tab).where(eq(submission_tab.userId, user_tab.id))),
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

  const result = { spamDeleted, auditDeleted, invitesDeleted, sessionsDeleted, verificationsDeleted, usersDeleted, tokensDeleted, oauthStatesDeleted, contributorsPruned, ipsCleared, groupsRepublished }
  if (spamDeleted + auditDeleted + invitesDeleted + sessionsDeleted + verificationsDeleted + usersDeleted + tokensDeleted + oauthStatesDeleted + contributorsPruned + ipsCleared + groupsRepublished > 0) {
    await writeAudit(db, { actor: 'system', action: 'system.housekeeping', detail: result }, now)
  }
  return result
}

