import type { Env } from '../env.ts'
import { plcCreatedAt } from './bluesky.ts'

export { ProviderUnavailable } from './provider-error.ts'

/**
 * Sign-in providers usable for contributor accounts. Discord goes through BetterAuth (its `socialProviders` config in auth.ts,
 * secrets in env.ts / docs/SETUP.md). Bluesky does not: it has its own OAuth flow (atproto.ts, routes/contrib.ts) and no secrets.
 * A provider whose account age cannot be determined right now throws ProviderUnavailable (the user retries; not "too young").
 */
export interface ProviderDef {
  id: string
  label: string
  configured(env: Env): boolean
  /** Epoch ms when the provider account was created, from its account id; null = unknown (treated as ineligible). */
  accountCreatedAt(accountId: string, env: Env): Promise<number | null>
}

const DISCORD_EPOCH = 1420070400000n

/** Discord snowflake → creation time. */
export function discordCreatedAt(id: string): number | null {
  if (!/^\d{15,25}$/.test(id)) return null
  const ms = (BigInt(id) >> 22n) + DISCORD_EPOCH
  return Number(ms)
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'discord',
    label: 'Discord',
    configured: (env) => !!env.DISCORD_CLIENT_ID && !!env.DISCORD_CLIENT_SECRET,
    accountCreatedAt: async (id) => discordCreatedAt(id),
  },
  {
    id: 'bluesky',
    label: 'Bluesky',
    // No secrets: a public OAuth client whose identity is derived from PUBLIC_URL.
    configured: (env) => !!env.PUBLIC_URL,
    accountCreatedAt: (did) => plcCreatedAt(did),
  },
]

export const getProvider = (id: string): ProviderDef | undefined => PROVIDERS.find((p) => p.id === id)
