import type { SubmissionTypeDef } from '../../core/types-registry.ts'
import { moderationSnippet } from '../tl-text.ts'
import { validateBioPayload, type BioPayload } from './validate.ts'

/**
 * Suggested English translation of one character bio. Account-only, never public, not editable:
 * approved rows are pulled by the wiki's intake Action (`GET /api/internal/submissions/lah-bio-tl`) and written into the Bio sheet tab.
 */
export const lahBioTl: SubmissionTypeDef<BioPayload> = {
  id: 'lah-bio-tl',
  langs: [{ value: 'en', label: 'English' }],
  tags: [],
  // text + base (each up to 2000 characters), note, key and JSON overhead.
  maxPayloadBytes: 12 * 1024,
  accountOnly: true,
  editable: false,
  publicList: false,
  rosterPath: '/api/bio-roster.json',
  validatePayload: validateBioPayload,
  moderationText: (p) => moderationSnippet([p.text]),
}
