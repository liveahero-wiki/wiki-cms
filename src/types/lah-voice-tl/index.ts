import type { SubmissionTypeDef } from '../../core/types-registry.ts'
import { moderationSnippet } from '../tl-text.ts'
import { validateVoicePayload, type VoicePayload } from './validate.ts'

/**
 * Suggested English voice-line translations (batch per resource). Account-only, never public, not editable:
 * approved rows are pulled by the wiki's intake Action (`GET /api/internal/submissions/lah-voice-tl`) and written into the voice sheet.
 */
export const lahVoiceTl: SubmissionTypeDef<VoicePayload> = {
  id: 'lah-voice-tl',
  langs: [{ value: 'en', label: 'English' }],
  tags: [],
  // 100 lines of about 1000 characters each way, plus keys and JSON overhead.
  maxPayloadBytes: 300 * 1024,
  maxBodyBytes: 400 * 1024,
  accountOnly: true,
  editable: false,
  publicList: false,
  rosterPath: '/api/voice-roster.json',
  validatePayload: validateVoicePayload,
  moderationText: (p) => moderationSnippet(p.lines.flatMap((l) => (l.jp ? [l.jp, l.text] : [l.text]))),
}
