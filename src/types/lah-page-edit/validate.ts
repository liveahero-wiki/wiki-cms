import type { FieldError, GroupInfo, ValidateContext, ValidateResult } from '../../core/types-registry.ts'
import { startsWithFence } from './frontmatter.ts'

/** A page edit: `after` is the whole new body (no front matter); the Worker re-attaches the current front matter. */
export interface PageEditPayload {
  /** Repo-relative path of an editable page, e.g. `_charas/ryekie.md`. */
  path: string
  /** Git blob sha (40 hex) of the file the contributor started from. */
  baseSha: string
  after: string
  summary: string
}

export const AFTER_MAX_CHARS = 120_000
export const SUMMARY_MIN = 3
export const SUMMARY_MAX = 120

const NAME = '[A-Za-z0-9_][A-Za-z0-9_.-]*'
/** _charas/*.md, _events/*.md, _main_quests/*.md, guide/*.md, chara_quests.md, mobs.md (one level, no `..`). */
const PATH_RE = new RegExp(`^(?:(?:_charas|_events|_main_quests|guide)/${NAME}\\.md|chara_quests\\.md|mobs\\.md)$`)
const SHA_RE = /^[0-9a-f]{40}$/
/** Control characters (incl. line breaks, DEL, C1) and the Unicode line/paragraph separators. */
const CONTROL_RE = /[\p{Cc}\p{Zl}\p{Zp}]/u

export function isEditablePath(path: string): boolean {
  return PATH_RE.test(path) && !path.includes('..')
}

const err = (path: string, code: string, message: string, params?: FieldError['params']): FieldError => ({ path, code, message, ...(params ? { params } : {}) })
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function validatePageEdit(input: unknown, _group?: GroupInfo, _ctx?: ValidateContext): ValidateResult<PageEditPayload> {
  if (!isObj(input)) return { ok: false, errors: [err('', 'payload_invalid', 'The payload must be an object.')] }
  const errors: FieldError[] = []

  const path = input.path
  if (typeof path !== 'string' || !isEditablePath(path)) {
    errors.push(err('path', 'path_not_editable', 'This page cannot be edited here.'))
  }

  const baseSha = typeof input.baseSha === 'string' ? input.baseSha.toLowerCase() : ''
  if (!SHA_RE.test(baseSha)) errors.push(err('baseSha', 'base_sha_invalid', 'baseSha must be a 40-character git blob sha.'))

  const after = input.after
  if (typeof after !== 'string') {
    errors.push(err('after', 'after_invalid', 'The new text must be a string.'))
  } else if (after.length > AFTER_MAX_CHARS) {
    errors.push(err('after', 'after_too_long', `The new text must be at most ${AFTER_MAX_CHARS} characters.`, { max: AFTER_MAX_CHARS }))
  } else if (after.includes('\u0000')) {
    errors.push(err('after', 'after_nul', 'The text must not contain NUL characters.'))
  } else if (startsWithFence(after)) {
    errors.push(err('after', 'after_front_matter', 'The text must not start with a front matter fence (---); front matter cannot be edited here.'))
  }

  const rawSummary = input.summary
  const summary = typeof rawSummary === 'string' ? rawSummary.trim() : ''
  if (typeof rawSummary !== 'string' || summary.length < SUMMARY_MIN || summary.length > SUMMARY_MAX) {
    errors.push(err('summary', 'summary_length', `The summary must be ${SUMMARY_MIN}-${SUMMARY_MAX} characters.`, { min: SUMMARY_MIN, max: SUMMARY_MAX }))
  } else if (CONTROL_RE.test(summary)) {
    errors.push(err('summary', 'summary_plain', 'The summary must be a single line of plain text.'))
  }

  if (errors.length) return { ok: false, errors }
  return { ok: true, value: { path: path as string, baseSha, after: after as string, summary } }
}
