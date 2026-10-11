import { isLang, type Lang } from '../shared/i18n.ts'
import { checkExplanation, renderExplanation } from '../shared/markdown-policy.ts'
import type { FieldError } from '../shared/plugin-api.ts'
import { normalizeDemoUrl } from './demo-url.ts'
import type { GroupInfo, ValidateContext } from './types-registry.ts'
import type { ResolvedType } from './types-runtime.ts'

export interface SubmissionInput {
  payload?: unknown
  tags?: unknown
  lang?: unknown
  explanation?: unknown
  demoUrl?: unknown
}

export interface ValidatedSubmission {
  payload: unknown
  tags: Record<string, string>
  lang: Lang
  explanation: string
  explanationHtml: string
  demoUrl: string
}

/**
 * Validate every user-supplied field (all errors at once). Used by the public submit and the admin edit.
 * `input` fields that are `undefined` are errors; admin edits merge with the stored row first.
 */
export function validateSubmission(
  rt: ResolvedType,
  group: GroupInfo,
  input: SubmissionInput,
  ctx: ValidateContext = {},
): { ok: true; value: ValidatedSubmission } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = []
  const def = rt.def

  // lang
  let lang: Lang = 'en'
  if (isLang(input.lang) && def.langs.some((l) => l.value === input.lang)) lang = input.lang as Lang
  else errors.push({ path: 'lang', code: 'lang_invalid', message: 'Unsupported language.' })

  // tags
  const tags: Record<string, string> = {}
  const rawTags = typeof input.tags === 'object' && input.tags !== null && !Array.isArray(input.tags) ? (input.tags as Record<string, unknown>) : {}
  for (const tag of def.tags) {
    const v = rawTags[tag.key]
    if (v === undefined || v === null || v === '') {
      if (tag.required) errors.push({ path: `tags.${tag.key}`, code: 'tag_required', message: `${tag.label.en} is required.` })
    } else if (typeof v === 'string' && tag.options.some((o) => o.value === v)) {
      tags[tag.key] = v
    } else {
      errors.push({ path: `tags.${tag.key}`, code: 'tag_invalid', message: `Invalid ${tag.label.en} value.` })
    }
  }

  // explanation
  const explanation = typeof input.explanation === 'string' ? input.explanation.replace(/\r\n?/g, '\n').trim() : ''
  if (!explanation) {
    errors.push({ path: 'explanation', code: 'explanation_required', message: 'An explanation is required.' })
  } else if (explanation.length > def.explanation.maxLength) {
    errors.push({
      path: 'explanation',
      code: 'explanation_too_long',
      message: `The explanation must be at most ${def.explanation.maxLength} characters.`,
      params: { max: def.explanation.maxLength },
    })
  } else {
    errors.push(...checkExplanation(explanation))
  }

  // demo url
  const demo = normalizeDemoUrl(input.demoUrl, def.demoUrl)
  if (!demo.ok) errors.push(demo.error)

  // payload
  let payload: unknown
  if (input.payload === undefined) {
    errors.push({ path: 'payload', code: 'payload_invalid', message: 'The payload is missing.' })
  } else if (JSON.stringify(input.payload).length > def.maxPayloadBytes) {
    errors.push({ path: 'payload', code: 'payload_too_large', message: 'The payload is too large.' })
  } else {
    const r = def.validatePayload(input.payload, group, ctx)
    if (r.ok) payload = r.value
    else errors.push(...r.errors)
  }

  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    value: {
      payload,
      tags,
      lang,
      explanation,
      explanationHtml: renderExplanation(explanation),
      demoUrl: (demo as { ok: true; value: string }).value,
    },
  }
}
