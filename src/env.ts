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
  /** Optional: unset = Google is not offered as a contributor sign-in. */
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  TURNSTILE_SECRET_KEY: string
  CLI_TOKEN: string

  // GitHub App (page edits become pull requests). Secrets: set with `wrangler secret put`. Optional: unset = approving a page edit fails with github_not_configured.
  GITHUB_APP_ID?: string
  /** PKCS#8 PEM (real newlines or literal `\n`). */
  GITHUB_APP_PRIVATE_KEY?: string
  GITHUB_APP_INSTALLATION_ID?: string
  GITHUB_WEBHOOK_SECRET?: string
  // Public vars (wrangler.jsonc).
  /** `owner/name` of the wiki repository. */
  GITHUB_REPO?: string
  /** Branch the PRs target (default `master`). */
  GITHUB_BASE_BRANCH?: string
  /** When set, this label is added to every PR (e.g. the wiki's preview label). Never set by default. */
  GITHUB_PREVIEW_LABEL?: string
}
