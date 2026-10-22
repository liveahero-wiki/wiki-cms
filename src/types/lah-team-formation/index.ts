import type { SubmissionTypeDef } from '../../core/types-registry.ts'
import { validateTeamPayload, type TeamPayload } from './validate.ts'

const TEMPLATE_EN = `## Overview
_What does this team do, and how does it win?_

## Key heroes & sidekicks
-

## Strategy / turn order
1.

## Notes
_Substitutes, important skill-tree nodes, what to do when RNG goes wrong._
`

const TEMPLATE_JA = `## 概要
_この編成は何をするもので、どうやって勝ちますか？_

## 主要なヒーロー＆サイドキック
-

## 立ち回り／ターン順
1.

## 補足
_代役、重要なスキルツリーのノード、運が悪かった時の対処など。_
`

const TEMPLATE_ZH_HANS = `## 概述
_这套队伍的思路是什么，如何获胜？_

## 主要英雄与助手
-

## 打法／回合顺序
1.

## 备注
_替补人选、重要的技能树节点、运气不好时的应对方法。_
`

const TEMPLATE_ZH_HANT = `## 概述
_這套隊伍的思路是什麼，如何獲勝？_

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
  title: {
    required: true,
    minLength: 4,
    maxLength: 50,
    label: { en: 'Team name', 'zh-Hans': '队伍名称', 'zh-Hant': '隊伍名稱', ja: '編成名' },
    placeholder: {
      en: 'e.g. SSS Lantern – 3-turn clear',
      'zh-Hans': '例如：SSS 灯笼型 3 回合通关',
      'zh-Hant': '例如：SSS 燈籠型 3 回合通關',
      ja: '例：SSS ランタン型 3ターン攻略',
    },
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
  explanation: {
    maxLength: 5000,
    template: { en: TEMPLATE_EN, ja: TEMPLATE_JA, 'zh-Hans': TEMPLATE_ZH_HANS, 'zh-Hant': TEMPLATE_ZH_HANT },
  },
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
  validatePayload: validateTeamPayload,
  moderationText: (p) => `team of ${p.heroes.length} heroes`,
}
