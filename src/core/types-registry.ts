import type { I18nText, Lang } from '../shared/i18n.ts'
import type { FieldError } from '../shared/plugin-api.ts'

export type { FieldError, I18nText, Lang }

export interface TagOption {
  value: string
  label: I18nText
}
export interface TagDef {
  key: string
  label: I18nText
  required: boolean
  /** Preselected in the submit form (the server still enforces `required` and never fills it in). */
  default?: string
  options: TagOption[]
}

/** Group info from the wiki's registry; `options` is type-specific and opaque to the core. */
export interface GroupInfo {
  id: string
  title: string
  url: string
  options: Record<string, unknown>
}

export interface ValidateContext {
  /** Parsed roster JSON (soft existence check); undefined when unavailable. */
  roster?: unknown
}

export type ValidateResult<P> = { ok: true; value: P } | { ok: false; errors: FieldError[] }

export interface SubmissionTypeDef<P = unknown> {
  /** Must match submission_type_tab.id. */
  id: string
  /** Content-language options; labels are endonyms and are not translated. */
  langs: { value: Lang; label: string }[]
  tags: TagDef[]
  /** Optional per-item name shown on every card (plain text). Types without it behave as before. */
  title?: { required: boolean; minLength: number; maxLength: number; label: I18nText; placeholder?: I18nText }
  /** Overrides the generic disclaimer text from the embed i18n bundle. */
  disclaimer?: I18nText
  explanation: { maxLength: number; template: Record<Lang, string> }
  demoUrl: { required: boolean; allowedHosts: string[] }
  maxPayloadBytes: number
  /** Path (relative to the type's groups_url) of the optional roster JSON used for the soft check. */
  rosterPath?: string
  validatePayload(input: unknown, group: GroupInfo, ctx?: ValidateContext): ValidateResult<P>
  /** Optional extra text for AI moderation. */
  moderationText?(p: P): string
}
