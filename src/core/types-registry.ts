import type { Env } from '../env.ts'
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
  /** The submission's language (a `def.langs` value); set by `validateSubmission`. */
  lang?: string
}

export type ValidateResult<P> = { ok: true; value: P } | { ok: false; errors: FieldError[] }

/** The stored row a type hook acts on (payload already parsed). */
export interface HookRow {
  id: string
  type: string
  groupId: string
  version: number
  lang: string
  payload: unknown
  /** What the type stored for itself earlier (see `external`), or null. */
  external: unknown
  owner: { id: string; displayName: string } | null
}

export type ApproveResult =
  | { ok: true; external?: unknown }
  | {
      ok: false
      status: 400 | 409 | 500 | 502
      code: string
      message: string
      /** Stored on the row (so moderators and the owner see why), the submission stays pending. */
      external?: unknown
    }

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
  /** Markdown explanation. Omit for types whose payload says everything (the stored explanation is then ''). */
  explanation?: { maxLength: number; template: Record<Lang, string> }
  /** Demo link. Omit for types without one (the stored demo URL is then ''). */
  demoUrl?: { required: boolean; allowedHosts: string[] }
  maxPayloadBytes: number
  /** Request body cap in bytes for this type (default MAX_BODY_BYTES). */
  maxBodyBytes?: number
  /** Only signed-in contributors may submit, whatever `submit_auth` says in D1 (default false). */
  accountOnly?: boolean
  /** A contributor can change their own submissions through PUT (default true). */
  editable?: boolean
  /** Approved rows are listed in the public blob and `GET /api/v1/submissions/:type/:group` works (default true). */
  publicList?: boolean
  /**
   * Runs before a moderator's approval is saved. On `ok: false` nothing changes except `external`. On success `external`
   * is stored on the row. Not called for bulk approvals: types with this hook are refused there.
   */
  onApprove?(env: Env, row: HookRow, now: number): Promise<ApproveResult>
  /** Path (relative to the type's groups_url) of the optional roster JSON used for the soft check. */
  rosterPath?: string
  validatePayload(input: unknown, group: GroupInfo, ctx?: ValidateContext): ValidateResult<P>
  /** Optional extra text for AI moderation. */
  moderationText?(p: P): string
}
