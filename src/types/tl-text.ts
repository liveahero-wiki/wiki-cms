import type { FieldError } from '../core/types-registry.ts'

// Shared rules of the translation types (lah-voice-tl, lah-bio-tl): plain text only, because the intake Action writes it
// into a Google Sheet that later becomes wiki HTML, so markup and Liquid must never get through.

export const TEXT_MAX = 2000
export const NOTE_MAX = 500
export const KEY_RE = /^[A-Za-z0-9_]+$/

export const err = (path: string, code: string, message: string, params?: FieldError['params']): FieldError => ({
  path,
  code,
  message,
  ...(params ? { params } : {}),
})

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The roster's short code of a submission language (the `langs` of a roster entry list these). */
export const rosterLang = (lang: string | undefined): 'en' | 'hans' | 'hant' => (lang === 'zh-Hans' ? 'hans' : lang === 'zh-Hant' ? 'hant' : 'en')

/**
 * Whether a roster entry still offers `lang`. An entry without `langs` (an older roster) offers every language,
 * and so does one that is not an object (the existence check is separate).
 */
export function langOpen(entry: unknown, lang: string | undefined): boolean {
  if (!isObj(entry) || !Array.isArray(entry.langs)) return true
  return entry.langs.includes(rosterLang(lang))
}

/** A non-English suggestion is translated from the Japanese text, so the roster entry needs one. */
export const hasJp = (entry: unknown): boolean => isObj(entry) && typeof entry.jp === 'string' && entry.jp.trim() !== ''

/** Line breaks as `\n` (CRLF and lone CR). */
export const normalizeNewlines = (s: string): string => s.replace(/\r\n?/g, '\n')

// Control characters other than \n (tab included), DEL and the C1 range.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/

/** Why `s` is not plain text, or null. */
function plainTextProblem(s: string): string | null {
  if (s.includes('<') || s.includes('>')) return 'HTML is not allowed: remove < and >.'
  if (s.includes('{%') || s.includes('{{') || s.includes('{#')) return 'Template syntax is not allowed: remove {%, {{ and {#.'
  if (CONTROL_RE.test(s)) return 'Control characters are not allowed.'
  return null
}

/** The suggested text: required, trimmed, plain. Pushes errors and returns the normalized value. */
export function readText(errors: FieldError[], path: string, v: unknown): string {
  if (typeof v !== 'string') {
    errors.push(err(path, 'text_required', 'A translation is required.'))
    return ''
  }
  const text = normalizeNewlines(v).trim()
  if (!text) errors.push(err(path, 'text_required', 'A translation is required.'))
  else if (text.length > TEXT_MAX) errors.push(err(path, 'text_too_long', `At most ${TEXT_MAX} characters.`, { max: TEXT_MAX }))
  else {
    const problem = plainTextProblem(text)
    if (problem) errors.push(err(path, 'text_invalid', problem))
  }
  return text
}

/** An optional text (the JP transcription of a voice line): plain, trimmed, same limits as `readText`; undefined when absent or blank. */
export function readOptionalText(errors: FieldError[], path: string, v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') {
    errors.push(err(path, 'text_invalid', 'Must be text.'))
    return undefined
  }
  if (!normalizeNewlines(v).trim()) return undefined
  return readText(errors, path, v)
}

/** `base`: the text the contributor saw (compared at sync time). Any string up to the limit, may be empty. Kept as sent. */
export function readBase(errors: FieldError[], path: string, v: unknown): string {
  if (typeof v !== 'string' || v.length > TEXT_MAX) {
    errors.push(err(path, 'base_invalid', `Must be text of at most ${TEXT_MAX} characters.`, { max: TEXT_MAX }))
    return ''
  }
  return v
}

/** Optional moderator note: plain text, trimmed, at most NOTE_MAX; undefined when absent or blank. */
export function readNote(errors: FieldError[], path: string, v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') {
    errors.push(err(path, 'note_invalid', 'The note must be text.'))
    return undefined
  }
  const note = normalizeNewlines(v).trim()
  if (!note) return undefined
  if (note.length > NOTE_MAX) errors.push(err(path, 'note_too_long', `At most ${NOTE_MAX} characters.`, { max: NOTE_MAX }))
  else {
    const problem = plainTextProblem(note)
    if (problem) errors.push(err(path, 'note_invalid', problem))
  }
  return note
}

/** True when the suggestion equals the text the contributor saw (ignoring surrounding space and line-break style). */
export const sameAsBase = (text: string, base: string): boolean => text === normalizeNewlines(base).trim()

/** Short plain text for the optional AI moderation. */
export function moderationSnippet(parts: string[], max = 3000): string {
  return parts.join('\n').slice(0, max)
}
