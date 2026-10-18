import type { FieldError, GroupInfo, ValidateContext, ValidateResult } from '../../core/types-registry.ts'
import { KEY_RE, err, isObj, readBase, readNote, readOptionalText, readText, sameAsBase } from '../tl-text.ts'

export interface VoiceLine {
  /** `voice_<resourceName>_<part>` */
  key: string
  /** The EN text the contributor saw (empty when there was none); used to detect conflicts at sync time. */
  base: string
  /** The EN suggestion; empty only when `jp` is given. */
  text: string
  /** The Japanese transcription of a line the game (and the sheet) has no Japanese text for. */
  jp?: string
}
export interface VoicePayload {
  resourceName: string
  lines: VoiceLine[]
  note?: string
}

export const MAX_LINES = 100

/** `roster.resources[resourceName]` is the translatable keys of that resource; null when there is no well-formed roster. */
function rosterResources(roster: unknown): Record<string, unknown> | null {
  return isObj(roster) && isObj(roster.resources) ? roster.resources : null
}

/**
 * `group` is unused (the type has one group, `all`) and the language is checked by the core against `def.langs`;
 * a language-aware rule (for example per-language translatability) would be added here via `ctx`.
 */
export function validateVoicePayload(input: unknown, _group?: GroupInfo, ctx: ValidateContext = {}): ValidateResult<VoicePayload> {
  const errors: FieldError[] = []
  if (!isObj(input)) return { ok: false, errors: [err('payload', 'payload_invalid', 'The suggestion is malformed.')] }

  const resourceName = input.resourceName
  const nameOk = typeof resourceName === 'string' && resourceName.length <= 100 && KEY_RE.test(resourceName)
  if (!nameOk) errors.push(err('payload.resourceName', 'resource_invalid', 'Invalid voice resource name.'))

  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > MAX_LINES) {
    errors.push(err('payload.lines', 'lines_length', `Suggest 1 to ${MAX_LINES} lines.`, { min: 1, max: MAX_LINES }))
    return { ok: false, errors }
  }

  const resources = rosterResources(ctx.roster)
  let known: Record<string, unknown> | null = null
  if (resources && nameOk) {
    const entry = Object.hasOwn(resources, resourceName) ? resources[resourceName] : undefined
    if (isObj(entry)) known = entry
    else errors.push(err('payload.resourceName', 'unknown_resource', 'This voice resource cannot be translated.'))
  }

  const prefix = nameOk ? `voice_${resourceName}_` : ''
  const seen = new Set<string>()
  const lines: VoiceLine[] = []
  input.lines.forEach((raw: unknown, i: number) => {
    const p = `payload.lines.${i}`
    if (!isObj(raw)) {
      errors.push(err(p, 'payload_invalid', 'The line is malformed.'))
      return
    }
    const key = raw.key
    let keyOk = false
    if (typeof key !== 'string' || key.length > 200 || !KEY_RE.test(key) || (nameOk && !(key.startsWith(prefix) && key.length > prefix.length))) {
      errors.push(err(`${p}.key`, 'key_invalid', 'The line does not belong to this voice resource.'))
    } else if (seen.has(key)) {
      errors.push(err(`${p}.key`, 'key_duplicate', 'This line is listed twice.'))
    } else {
      keyOk = true
      seen.add(key)
      if (known && !Object.hasOwn(known, key)) {
        errors.push(err(`${p}.key`, 'line_not_translatable', 'This line cannot be translated.'))
      }
    }
    const base = readBase(errors, `${p}.base`, raw.base)
    // A line the game has no Japanese text for may carry the transcription; then the translation is optional.
    const jp = readOptionalText(errors, `${p}.jp`, raw.jp)
    if (jp !== undefined && keyOk && known && Object.hasOwn(known, key as string)) {
      const entry = known[key as string]
      if (isObj(entry) && typeof entry.jp === 'string' && entry.jp.trim()) {
        errors.push(err(`${p}.jp`, 'jp_not_allowed', 'This line already has Japanese text.'))
      }
    }
    const text = jp === undefined ? readText(errors, `${p}.text`, raw.text) : (readOptionalText(errors, `${p}.text`, raw.text) ?? '')
    if (text && typeof raw.base === 'string' && sameAsBase(text, base)) {
      errors.push(err(`${p}.text`, 'text_same_as_base', 'The suggestion is the same as the current text.'))
    }
    if (keyOk) lines.push({ key: key as string, base, text, ...(jp !== undefined ? { jp } : {}) })
  })

  const note = readNote(errors, 'payload.note', input.note)
  if (errors.length) return { ok: false, errors }
  return { ok: true, value: { resourceName: resourceName as string, lines, ...(note ? { note } : {}) } }
}
