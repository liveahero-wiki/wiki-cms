import { teamFormationType } from '../team-formation.ts'
import { validateTeamPayload, type TeamPayload } from './validate.ts'

const TEMPLATE_EN = `## Overview
_What does this team do, and how does it win?_

## Key cards & equipment
-

## Strategy / turn order
1.

## Notes
_Substitutes, skill seeds worth farming, what to do when RNG goes wrong._
`

const TEMPLATE_JA = `## 概要
_この編成は何をするもので、どうやって勝ちますか？_

## 主要なカード＆装備
-

## 立ち回り／ターン順
1.

## 補足
_代役、育てておきたいスキル種、運が悪かった時の対処など。_
`

const TEMPLATE_ZH_HANS = `## 概述
_这套队伍的思路是什么，如何获胜？_

## 主要卡牌与装备
-

## 打法／回合顺序
1.

## 备注
_替补人选、值得培养的技能种子、运气不好时的应对方法。_
`

const TEMPLATE_ZH_HANT = `## 概述
_這套隊伍的思路是什麼，如何獲勝？_

## 主要卡牌與裝備
-

## 打法／回合順序
1.

## 備註
_替補人選、值得培養的技能種子、運氣不好時的應對方法。_
`

export const housamoTeamFormation = teamFormationType<TeamPayload>({
  id: 'housamo-team-formation',
  placeholder: {
    en: 'e.g. Fire team – Event stage 12',
    'zh-Hans': '例如：火属性队 – 活动第 12 关',
    'zh-Hant': '例如：火屬性隊 – 活動第 12 關',
    ja: '例：火属性編成 – イベント12ステージ',
  },
  template: { en: TEMPLATE_EN, ja: TEMPLATE_JA, 'zh-Hans': TEMPLATE_ZH_HANS, 'zh-Hant': TEMPLATE_ZH_HANT },
  validatePayload: validateTeamPayload,
  moderationText: (p) => `team of ${p.cards.length} cards`,
})
