import type { SubmissionTypeDef } from '../../core/types-registry.ts'
import { approvePageEdit } from './approve.ts'
import { validatePageEdit, type PageEditPayload } from './validate.ts'

/**
 * A contributor's edit of a wiki page body. Account-only, never listed publicly, not editable by the owner after submitting.
 * Approval turns it into a GitHub pull request (see approve.ts); the structural guard lives here, the Liquid/HTML guard in the wiki's CI.
 */
export const lahPageEdit: SubmissionTypeDef<PageEditPayload> = {
  id: 'lah-page-edit',
  langs: [{ value: 'en', label: 'English' }],
  tags: [],
  // `after` is capped in characters (AFTER_MAX_CHARS); the body is counted in UTF-8 bytes, so leave room for 3-byte CJK text and JSON escapes.
  maxPayloadBytes: 400_000,
  maxBodyBytes: 512 * 1024,
  accountOnly: true,
  editable: false,
  publicList: false,
  validatePayload: validatePageEdit,
  onApprove: approvePageEdit,
  moderationText: (p) => p.summary,
}
