import type { SubmissionTypeDef } from '../../core/types-registry.ts'
import { validateTeamPayload, type TeamPayload } from './validate.ts'

const TEMPLATE_EN = `## Overview
_Which quest / difficulty is this team for?_

## Key heroes & sidekicks
-

## Strategy / turn order
1.

## Notes
_Substitutes, important skill-tree nodes, what to do when RNG goes wrong._
`

const TEMPLATE_JA = `## 概要
_どのクエスト／難易度向けの編成ですか？_

## 主要なヒーロー＆サイドキック
-

## 立ち回り／ターン順
1.

## 補足
_代役、重要なスキルツリーのノード、運が悪かった時の対処など。_
`

const TEMPLATE_ZH_HANS = `## 概述
_这套队伍适用于哪个任务／难度？_

## 主要英雄与助手
-

## 打法／回合顺序
1.

## 备注
_替补人选、重要的技能树节点、运气不好时的应对方法。_
`

const TEMPLATE_ZH_HANT = `## 概述
_這套隊伍適用於哪個任務／難度？_

## 主要英雄與助手
-

## 打法／回合順序
1.

## 備註
_替補人選、重要的技能樹節點、運氣不好時的應對方法。_
`

export const lahTeamFormation: SubmissionTypeDef<TeamPayload> = {
  id: 'lah-team-formation',
  langs: [
    { value: 'en', label: 'English' },
    { value: 'zh-Hans', label: '简体中文' },
    { value: 'zh-Hant', label: '繁體中文' },
    { value: 'ja', label: '日本語' },
  ],
  tags: [
    {
      key: 'rng',
      label: { en: 'RNG', 'zh-Hans': '随机性', 'zh-Hant': '隨機性', ja: '運要素' },
      required: true,
      options: [
        {
          value: 'none',
          label: { en: 'No RNG', 'zh-Hans': '无随机性', 'zh-Hant': '無隨機性', ja: '運要素なし' },
        },
        {
          value: 'few',
          label: { en: '1~2 retries', 'zh-Hans': '重试 1~2 次', 'zh-Hant': '重試 1~2 次', ja: '1～2回のリトライ' },
        },
        {
          value: 'many',
          label: { en: 'More retries', 'zh-Hans': '需多次重试', 'zh-Hant': '需多次重試', ja: '多めのリトライ' },
        },
        {
          value: 'impractical',
          label: { en: 'Near impractical', 'zh-Hans': '几乎不现实', 'zh-Hant': '幾乎不實際', ja: 'ほぼ非現実的' },
        },
      ],
    },
  ],
  explanation: {
    maxLength: 5000,
    template: { en: TEMPLATE_EN, ja: TEMPLATE_JA, 'zh-Hans': TEMPLATE_ZH_HANS, 'zh-Hant': TEMPLATE_ZH_HANT },
  },
  demoUrl: {
    required: true,
    allowedHosts: [
      'youtube.com',
      'www.youtube.com',
      'm.youtube.com',
      'youtu.be',
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
  validatePayload: validateTeamPayload,
  moderationText: (p) => `team of ${p.heroes.length} heroes`,
}
