import type { Env } from '../env.ts'

/**
 * Sign-in providers usable for contributor accounts. Adding one (Reddit, X, GitHub…) = an entry here,
 * its `socialProviders` config in auth.ts and its secrets in env.ts / docs/SETUP.md.
 */
export interface ProviderDef {
  id: string
  label: string
  configured(env: Env): boolean
  /** Epoch ms when the provider account was created, from its account id; null = unknown (treated as ineligible). */
  accountCreatedAt(accountId: string): number | null
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
    accountCreatedAt: discordCreatedAt,
  },
]

export const getProvider = (id: string): ProviderDef | undefined => PROVIDERS.find((p) => p.id === id)
