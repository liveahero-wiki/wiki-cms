import type { Env } from '../env.ts'

/**
 * Sign-in providers usable for contributor accounts. Adding one (Reddit, X, GitHub…) = an entry here,
 * its `socialProviders` config in auth.ts and its secrets in env.ts / docs/SETUP.md.
 */
export interface ProviderDef {
  id: string
  label: string
  configured(env: Env): boolean
  /** Whether the provider account must be CONTRIB_MIN_ACCOUNT_AGE_DAYS old to become a contributor. False when the provider exposes no creation date. */
  ageGate: boolean
  /** Epoch ms when the provider account was created, from its account id; null = unknown (ineligible when `ageGate`). */
  accountCreatedAt(accountId: string): number | null
  /** The provider returns a real name, so a new contributor is asked for a display name instead of taking the profile name. */
  promptDisplayName: boolean
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
    ageGate: true,
    accountCreatedAt: discordCreatedAt,
    promptDisplayName: false,
  },
  {
    id: 'google',
    label: 'Google',
    configured: (env) => !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET,
    ageGate: false,
    accountCreatedAt: () => null,
    promptDisplayName: true,
  },
]

export const getProvider = (id: string): ProviderDef | undefined => PROVIDERS.find((p) => p.id === id)
