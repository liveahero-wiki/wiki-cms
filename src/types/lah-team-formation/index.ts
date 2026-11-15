import { teamFormationType } from '../team-formation.ts'
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

export const lahTeamFormation = teamFormationType<TeamPayload>({
  id: 'lah-team-formation',
  placeholder: {
    en: 'e.g. SSS Lantern – 3-turn clear',
    'zh-Hans': '例如：SSS 灯笼型 3 回合通关',
    'zh-Hant': '例如：SSS 燈籠型 3 回合通關',
    ja: '例：SSS ランタン型 3ターン攻略',
  },
  template: { en: TEMPLATE_EN, ja: TEMPLATE_JA, 'zh-Hans': TEMPLATE_ZH_HANS, 'zh-Hant': TEMPLATE_ZH_HANT },
  validatePayload: validateTeamPayload,
  moderationText: (p) => `team of ${p.heroes.length} heroes`,
})
