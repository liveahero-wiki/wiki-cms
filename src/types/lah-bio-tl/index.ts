import type { SubmissionTypeDef } from '../../core/types-registry.ts'
import { moderationSnippet } from '../tl-text.ts'
import { validateBioPayload, type BioPayload } from './validate.ts'

/**
 * Suggested translation (English or Chinese, by the submission's `lang`) of one character bio. Account-only, never public, not editable:
 * approved rows are pulled by the wiki's intake Action (`GET /api/internal/submissions/lah-bio-tl`) and written into the Bio sheet tab.
 */
export const lahBioTl: SubmissionTypeDef<BioPayload> = {
  id: 'lah-bio-tl',
  langs: [
    { value: 'en', label: 'English' },
    { value: 'zh-Hans', label: '简体中文' },
    { value: 'zh-Hant', label: '繁體中文' },
  ],
  tags: [],
  // text + base (each up to 2000 characters), note, key and JSON overhead. The payload cap counts characters; even
  // all-CJK text (3 UTF-8 bytes each) stays under the default 32 KB body cap.
  maxPayloadBytes: 12 * 1024,
  accountOnly: true,
  editable: false,
  publicList: false,
  rosterPath: '/api/bio-roster.json',
  validatePayload: validateBioPayload,
  moderationText: (p) => moderationSnippet([p.text]),
}
