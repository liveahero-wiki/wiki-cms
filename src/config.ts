/** Bump when the published blob shape or tag/lang labels change (also needs a purge-everything). */
export const PUBLISH_REV = 2

export const KV_PUBLISH_TTL_SECONDS = 60 * 60 * 24 * 90
export const MAX_BODY_BYTES = 32 * 1024

export const SUBMISSIONS_PER_IP_PER_DAY = 10
export const MAX_PENDING_PER_TYPE = 500

export const SPAM_RETENTION_DAYS = 14
export const AUDIT_RETENTION_DAYS = 30
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000
export const INVITE_PURGE_AFTER_DAYS = 7
/** `ip` is nulled on submissions older than this (the coarser `ip_key` is kept). */
export const IP_RETENTION_DAYS = 90
export const ORPHAN_USER_AFTER_MS = 24 * 60 * 60 * 1000

export const GROUP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const TYPE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export const DAY_MS = 24 * 60 * 60 * 1000
export const HOUR_MS = 60 * 60 * 1000

/** Default cap on Discord notifications per submission type per hour (override with `cms type update --webhook-per-hour`). */
export const WEBHOOK_MAX_PER_HOUR_DEFAULT = 10

// ---- Contributor accounts ----
export const CONTRIB_TOKEN_TTL_MS = 30 * DAY_MS
/** A new contributor's provider account must be at least this old (checked once, when the contributor account is created). */
export { CONTRIB_MIN_ACCOUNT_AGE_DAYS } from './shared/contrib.ts'
/** Creates + edits per contributor per type per 24 h (in addition to the per-IP cap). */
export const SUBMISSIONS_PER_USER_PER_DAY = 10
/** Contributor accounts with no submissions, no live token and no sign-in for this long are pruned. */
export const CONTRIB_IDLE_PRUNE_DAYS = 180
export const DISPLAY_NAME_MIN = 2
export const DISPLAY_NAME_MAX = 32
export const REJECT_REASON_MAX = 500
