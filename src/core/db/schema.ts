import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// ---- BetterAuth tables (names mapped via modelName in auth.ts) ----

export const user_tab = sqliteTable('user_tab', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

export const session_tab = sqliteTable(
  'session_tab',
  {
    id: text('id').primaryKey(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user_tab.id, { onDelete: 'cascade' }),
  },
  (t) => [index('session_user').on(t.userId)],
)

export const account_tab = sqliteTable(
  'account_tab',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user_tab.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('account_user').on(t.userId)],
)

export const verification_tab = sqliteTable(
  'verification_tab',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('verification_identifier').on(t.identifier)],
)

// ---- App tables. Times are integer milliseconds (UTC epoch). ----

export const submission_type_tab = sqliteTable('submission_type_tab', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  enabled: integer('enabled').notNull().default(1),
  allowedOrigins: text('allowed_origins').notNull(), // JSON array
  pluginUrl: text('plugin_url').notNull(),
  groupsUrl: text('groups_url').notNull(),
  createdAt: integer('created_at').notNull(),
  // Discord notification for new pending submissions. The webhook URL is a secret: never expose it via an API.
  discordWebhookUrl: text('discord_webhook_url'),
  discordThreadId: text('discord_thread_id'),
  webhookPerHour: integer('webhook_per_hour').notNull().default(10),
  webhookWindowStart: integer('webhook_window_start').notNull().default(0),
  webhookWindowCount: integer('webhook_window_count').notNull().default(0),
})

export const submission_tab = sqliteTable(
  'submission_tab',
  {
    id: text('id').primaryKey(),
    type: text('type')
      .notNull()
      .references(() => submission_type_tab.id),
    groupId: text('group_id').notNull(),
    state: text('state', { enum: ['pending', 'approved', 'spam'] }).notNull(),
    version: integer('version').notNull().default(1),
    payload: text('payload').notNull(),
    tags: text('tags').notNull(),
    lang: text('lang').notNull(),
    explanation: text('explanation').notNull(),
    explanationHtml: text('explanation_html').notNull(),
    demoUrl: text('demo_url').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    stateChangedAt: integer('state_changed_at').notNull(),
    moderatedBy: text('moderated_by'),
    original: text('original'),
    ip: text('ip'),
    ipKey: text('ip_key').notNull(),
    country: text('country'),
    aiVerdict: text('ai_verdict'),
    aiReason: text('ai_reason'),
  },
  (t) => [
    index('submission_list').on(t.type, t.groupId, t.state, sql`${t.createdAt} DESC`),
    index('submission_state').on(t.state, t.stateChangedAt),
    index('submission_ip').on(t.ipKey, t.createdAt),
  ],
)

export const moderator_permission_tab = sqliteTable(
  'moderator_permission_tab',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user_tab.id, { onDelete: 'cascade' }),
    type: text('type')
      .notNull()
      .references(() => submission_type_tab.id),
    grantedBy: text('granted_by'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.type] })],
)

export const invite_tab = sqliteTable('invite_tab', {
  tokenHash: text('token_hash').primaryKey(),
  createdBy: text('created_by'),
  types: text('types').notNull(), // JSON array
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  usedBy: text('used_by'),
  usedAt: integer('used_at'),
  revokedAt: integer('revoked_at'),
})

export const ip_block_tab = sqliteTable('ip_block_tab', {
  ipKey: text('ip_key').primaryKey(),
  reason: text('reason'),
  createdBy: text('created_by'),
  createdAt: integer('created_at').notNull(),
})

export const audit_log_tab = sqliteTable(
  'audit_log_tab',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: integer('at').notNull(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    type: text('type'),
    target: text('target'),
    detail: text('detail'),
  },
  (t) => [index('audit_at').on(t.at)],
)

export const schema = {
  user_tab,
  session_tab,
  account_tab,
  verification_tab,
  submission_type_tab,
  submission_tab,
  moderator_permission_tab,
  invite_tab,
  ip_block_tab,
  audit_log_tab,
}
