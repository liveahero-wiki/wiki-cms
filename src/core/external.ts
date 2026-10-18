import type { ExternalOutcome } from '../shared/api-types.ts'

// `submission_tab.external`: what a type (or the intake Action) recorded about a submission after approval. It is a JSON object
// owned by the type; the core only understands `outcome` ({ status, url?, label? }), the one part the contributor is shown.

export const MAX_EXTERNAL_BYTES = 16 * 1024

export type External = { outcome?: ExternalOutcome; [key: string]: unknown }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Normalizes an outcome from untrusted input (https urls only, bounded strings); undefined when it is not usable. */
export function cleanOutcome(v: unknown): ExternalOutcome | undefined {
  if (!isObject(v) || typeof v.status !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(v.status)) return undefined
  const out: ExternalOutcome = { status: v.status }
  if (typeof v.url === 'string') {
    try {
      const u = new URL(v.url)
      if (u.protocol === 'https:' && v.url.length <= 300) out.url = u.toString()
    } catch {
      /* dropped */
    }
  }
  if (typeof v.label === 'string' && v.label.trim()) out.label = v.label.trim().slice(0, 200)
  return out
}

/** Validates a value the intake Action or a type wants to store; returns the JSON to save or an error message. */
export function encodeExternal(value: unknown): { ok: true; json: string } | { ok: false; message: string } {
  if (!isObject(value)) return { ok: false, message: 'external must be an object.' }
  const outcome = value.outcome === undefined ? undefined : cleanOutcome(value.outcome)
  if (value.outcome !== undefined && !outcome) return { ok: false, message: 'external.outcome needs a status like "synced".' }
  const json = JSON.stringify({ ...value, ...(outcome ? { outcome } : {}) })
  if (new TextEncoder().encode(json).length > MAX_EXTERNAL_BYTES) return { ok: false, message: 'external is too large.' }
  return { ok: true, json }
}

export function parseExternal(raw: string | null): External | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return isObject(v) ? (v as External) : null
  } catch {
    return null
  }
}

/** The part of `external` the owner may see. */
export function outcomeOf(raw: string | null): ExternalOutcome | null {
  const e = parseExternal(raw)
  return (e?.outcome && cleanOutcome(e.outcome)) || null
}
