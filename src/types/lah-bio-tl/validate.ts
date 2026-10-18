import type { FieldError, GroupInfo, ValidateContext, ValidateResult } from '../../core/types-registry.ts'
import { KEY_RE, err, isObj, readBase, readNote, readText, sameAsBase } from '../tl-text.ts'

export interface BioPayload {
  /** The game's bio key, e.g. `DETAIL_CEPH_H01`. */
  key: string
  /** The EN text the contributor saw (empty when there was none); used to detect conflicts at sync time. */
  base: string
  text: string
  note?: string
}

/** `roster.bios` maps every translatable bio key to its texts; null when there is no well-formed roster. */
function rosterBios(roster: unknown): Record<string, unknown> | null {
  return isObj(roster) && isObj(roster.bios) ? roster.bios : null
}

/** One bio per submission. Same text rules as the voice type; `group` is unused and the language is checked by the core. */
export function validateBioPayload(input: unknown, _group?: GroupInfo, ctx: ValidateContext = {}): ValidateResult<BioPayload> {
  const errors: FieldError[] = []
  if (!isObj(input)) return { ok: false, errors: [err('payload', 'payload_invalid', 'The suggestion is malformed.')] }

  const key = input.key
  const keyOk = typeof key === 'string' && key.length <= 100 && KEY_RE.test(key)
  if (!keyOk) errors.push(err('payload.key', 'key_invalid', 'Invalid bio key.'))
  else {
    const bios = rosterBios(ctx.roster)
    if (bios && !Object.hasOwn(bios, key)) errors.push(err('payload.key', 'bio_not_translatable', 'This bio cannot be translated.'))
  }

  const base = readBase(errors, 'payload.base', input.base)
  const text = readText(errors, 'payload.text', input.text)
  if (text && typeof input.base === 'string' && sameAsBase(text, base)) {
    errors.push(err('payload.text', 'text_same_as_base', 'The suggestion is the same as the current text.'))
  }
  const note = readNote(errors, 'payload.note', input.note)

  if (errors.length) return { ok: false, errors }
  return { ok: true, value: { key: key as string, base, text, ...(note ? { note } : {}) } }
}
