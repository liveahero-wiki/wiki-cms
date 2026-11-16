// Which AR equipment a card may wear. Pure and dependency-free: housamo-wiki copies this logic client-side
// (web/team-creator), so keep both in sync. The limits come from Master_Equip.limitations
// ([type, value] pairs, tools/relations.py `generate_equip_limitations`); they are OR-ed.

export interface EquipLike {
  /** `[type, value]` pairs. Empty = any card. */
  limits: ReadonlyArray<readonly [number, number]>
}

export interface CardLike {
  element: number
  weapon: number
  rarity: number
  /** Character id (`character_id` of the master card). */
  chara: number
  guilds: readonly number[]
  schools: readonly number[]
  affils: readonly number[]
}

/**
 * Limit types: 1 element, 2 weapon, 5 rarity (card.rarity <= value), 6 chara, 7 guild, 8 school, 9 affiliation.
 * `dispatchGuild`: the guild the card is dispatched to; it counts as one more guild of the card for the guild limit only.
 */
export function equipAllowed(equip: EquipLike, card: CardLike, dispatchGuild?: number | null): boolean {
  if (equip.limits.length === 0) return true
  return equip.limits.some(([type, value]) => {
    switch (type) {
      case 1:
        return card.element === value
      case 2:
        return card.weapon === value
      case 5:
        return card.rarity <= value
      case 6:
        return card.chara === value
      case 7:
        return card.guilds.includes(value) || dispatchGuild === value
      case 8:
        return card.schools.includes(value)
      case 9:
        return card.affils.includes(value)
      default:
        return false
    }
  })
}
