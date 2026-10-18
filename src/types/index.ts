import type { SubmissionTypeDef } from '../core/types-registry.ts'
import { lahBioTl } from './lah-bio-tl/index.ts'
import { lahPageEdit } from './lah-page-edit/index.ts'
import { lahTeamFormation } from './lah-team-formation/index.ts'
import { lahVoiceTl } from './lah-voice-tl/index.ts'

export const TYPE_DEFS: SubmissionTypeDef<any>[] = [lahTeamFormation, lahVoiceTl, lahBioTl, lahPageEdit]
