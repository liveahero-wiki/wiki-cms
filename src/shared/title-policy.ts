import { LINK_RE } from './markdown-policy.ts'
import type { FieldError } from './plugin-api.ts'

/** Title rules of a submission type (`SubmissionTypeDef.title`). */
export interface TitleRules {
  required: boolean
  minLength: number
  maxLength: number
}

// Bare domains such as "example.com" or "foo.gg/bar" (a short list of common TLDs keeps "Lv.60" and "No.1" legal).
const DOMAIN_RE = /\b[a-z0-9-]{2,}\.(?:com|net|org|io|gg|jp|cn|tv|me|co|xyz|info|ly|to|app|dev|link|site|top|cc|ru)\b/i
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/

/** NFKC-normalise, trim and collapse whitespace runs into single spaces. */
export function normalizeTitle(raw: unknown): string {
  return typeof raw === 'string' ? raw.normalize('NFKC').replace(/\s+/g, ' ').trim() : ''
}

/** Length of a normalised title in code points (so emoji and CJK count as one). */
export const titleLength = (normalized: string) => [...normalized].length

/**
 * Validate a title (pure; mirrored client-side by the form). Errors: `title_required`, `title_too_short`,
 * `title_too_long`, `title_link`, `title_invalid` (control characters).
 */
export function checkTitle(raw: unknown, rules: TitleRules, path = 'title'): { value: string; errors: FieldError[] } {
  const value = normalizeTitle(raw)
  const errors: FieldError[] = []
  const len = titleLength(value)
  if (len === 0) {
    if (rules.required) errors.push({ path, code: 'title_required', message: 'A name is required.' })
    return { value, errors }
  }
  if (typeof raw === 'string' && CONTROL_RE.test(raw.replace(/\s/g, ' '))) {
    errors.push({ path, code: 'title_invalid', message: 'The name contains invalid characters.' })
  }
  if (len < rules.minLength) {
    errors.push({ path, code: 'title_too_short', message: `The name must be at least ${rules.minLength} characters.`, params: { min: rules.minLength } })
  } else if (len > rules.maxLength) {
    errors.push({ path, code: 'title_too_long', message: `The name must be at most ${rules.maxLength} characters.`, params: { max: rules.maxLength } })
  }
  if (LINK_RE.test(value) || DOMAIN_RE.test(value)) {
    errors.push({ path, code: 'title_link', message: 'Links are not allowed in the name.' })
  }
  return { value, errors }
}
