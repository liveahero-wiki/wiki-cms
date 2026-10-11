export interface Env {
  DB: D1Database
  KV: KVNamespace
  ASSETS: Fetcher
  SUBMIT_LIMITER: RateLimit
  AI?: Ai

  PUBLIC_URL: string
  TURNSTILE_SITE_KEY: string
  AI_MODERATION: 'off' | 'flag' | 'auto'

  BETTER_AUTH_SECRET: string
  DISCORD_CLIENT_ID: string
  DISCORD_CLIENT_SECRET: string
  TURNSTILE_SECRET_KEY: string
  CLI_TOKEN: string
}
