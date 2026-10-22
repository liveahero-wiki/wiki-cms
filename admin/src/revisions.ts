import type { AdminOwner, AdminRevision, AdminSubmission } from '../../src/shared/api-types.ts'

export type RevisionField = 'title' | 'payload' | 'tags' | 'lang' | 'demoUrl' | 'explanation'

/** JSON with sorted object keys, so equal values compare equal whatever the key order. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

type Fields = Pick<AdminSubmission, RevisionField>

/** Fields in which the proposed revision differs from the published submission. */
export function changedFields(current: Fields, proposed: Fields): RevisionField[] {
  const out: RevisionField[] = []
  if (current.title !== proposed.title) out.push('title')
  if (stableStringify(current.payload) !== stableStringify(proposed.payload)) out.push('payload')
  if (stableStringify(current.tags) !== stableStringify(proposed.tags)) out.push('tags')
  if (current.lang !== proposed.lang) out.push('lang')
  if (current.demoUrl !== proposed.demoUrl) out.push('demoUrl')
  if (current.explanation !== proposed.explanation) out.push('explanation')
  return out
}

/** True when a moderator changed the submission after the contributor started editing. */
export const baseIsStale = (rev: Pick<AdminRevision, 'baseVersion' | 'submission'>): boolean => rev.baseVersion < rev.submission.version

const PROVIDERS: Record<string, string> = { discord: 'Discord', github: 'GitHub', google: 'Google' }

export function providerLabel(provider: string | null): string {
  if (!provider) return 'Account'
  return PROVIDERS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1)
}

/** "Discord 123456…" (long ids are shortened; the full id belongs in a tooltip), or null without a provider account. */
export function ownerAccountLabel(owner: Pick<AdminOwner, 'provider' | 'accountId'>): string | null {
  if (!owner.accountId) return null
  const id = owner.accountId.length > 8 ? `${owner.accountId.slice(0, 6)}…` : owner.accountId
  return `${providerLabel(owner.provider)} ${id}`
}
