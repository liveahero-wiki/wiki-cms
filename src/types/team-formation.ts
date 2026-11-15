// What every wiki's team-formation submission type shares: content languages, the team name field, the team type and
// success rate tags, the explanation size, the demo link hosts, the payload cap and the roster path. A wiki's type only
// adds its id, name placeholder, explanation templates and payload validator.

import type { I18nText, Lang, SubmissionTypeDef } from '../core/types-registry.ts'

export interface TeamFormationOptions<P> {
  id: string
  /** Example team name shown in the empty title field. */
  placeholder: I18nText
  /** Markdown explanation template per content language. */
  template: Record<Lang, string>
  validatePayload: SubmissionTypeDef<P>['validatePayload']
  moderationText: NonNullable<SubmissionTypeDef<P>['moderationText']>
}

export function teamFormationType<P>({ id, placeholder, template, validatePayload, moderationText }: TeamFormationOptions<P>): SubmissionTypeDef<P> {
  return {
    id,
    langs: [
      { value: 'en', label: 'English' },
      { value: 'zh-Hans', label: '简体中文' },
      { value: 'zh-Hant', label: '繁體中文' },
      { value: 'ja', label: '日本語' },
    ],
    title: {
      required: true,
      minLength: 4,
      maxLength: 50,
      label: { en: 'Team name', 'zh-Hans': '队伍名称', 'zh-Hant': '隊伍名稱', ja: '編成名' },
      placeholder,
    },
    tags: [
      {
        key: 'teamType',
        label: { en: 'Team type', 'zh-Hans': '队伍类型', 'zh-Hant': '隊伍類型', ja: '編成タイプ' },
        required: true,
        default: 'manual',
        options: [
          { value: 'manual', label: { en: 'Manual', 'zh-Hans': '手动', 'zh-Hant': '手動', ja: '手動' } },
          { value: 'auto', label: { en: 'Full auto', 'zh-Hans': '全自动', 'zh-Hant': '全自動', ja: 'フルオート' } },
        ],
      },
      {
        key: 'successRate',
        label: { en: 'Success rate', 'zh-Hans': '成功率', 'zh-Hant': '成功率', ja: '成功率' },
        required: true,
        options: [
          { value: 'high', label: { en: 'High', 'zh-Hans': '高', 'zh-Hant': '高', ja: '高い' } },
          { value: 'medium', label: { en: 'Medium (some retries)', 'zh-Hans': '中（需重试）', 'zh-Hant': '中（需重試）', ja: '普通（リトライあり）' } },
          { value: 'low', label: { en: 'Low (near impractical)', 'zh-Hans': '低（几乎不现实）', 'zh-Hant': '低（幾乎不實際）', ja: '低い（ほぼ非現実的）' } },
        ],
      },
    ],
    explanation: { maxLength: 5000, template },
    demoUrl: {
      required: false,
      allowedHosts: [
        'youtube.com',
        'www.youtube.com',
        'm.youtube.com',
        'youtu.be',
        'bilibili.com',
        'www.bilibili.com',
        'm.bilibili.com',
        'b23.tv',
        'twitter.com',
        'www.twitter.com',
        'mobile.twitter.com',
        'x.com',
        'www.x.com',
        'bsky.app',
      ],
    },
    maxPayloadBytes: 4096,
    rosterPath: '/api/team-roster.json',
    validatePayload,
    moderationText,
  }
}
