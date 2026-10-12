/** Bump when the published blob shape or tag/lang labels change (also needs a purge-everything). */
export const PUBLISH_REV = 1

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
