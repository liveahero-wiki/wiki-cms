import type { FieldError, GroupInfo, ValidateContext, ValidateResult } from '../../core/types-registry.ts'
import { equipAllowed, type CardLike, type EquipLike } from './eligibility.ts'

export interface TeamCard {
  cardId: number
  lv: number
  /** Skill level. */
  slv: number
  /** Sacred artifact level. */
  salv: number
  /** 0-20, only above 0 when `lv` is the card's max level. */
  lvSeed: number
  skillSeed: number
  hpSeed: number
  atkSeed: number
  equipId: number | null
  /** Present exactly when `equipId` is not null. */
  equipLv?: number
  /** Guild dispatch: the card also counts as a member of this guild (widens its equips). Absent = none; never one of the card's own guilds. */
  dispatchGuild?: number
  /** Ring effect. Absent = none. */
  ringEffect?: RingEffect
}

/** The ring effects a card can carry (one at most): +1000 HP, +1000 ATK, +10% skill activation rate, +10 CP per turn. */
export const RING_EFFECTS = ['hp', 'atk', 'proc', 'cp'] as const
export type RingEffect = (typeof RING_EFFECTS)[number]
const isRingEffect = (v: unknown): v is RingEffect => typeof v === 'string' && (RING_EFFECTS as readonly string[]).includes(v)

export interface TeamGuild {
  id: number
  atkDef: number
  cp: number
  proc: number
  base: number
}

export interface TeamPayload {
  v: 1
  /** Slot order matters. `supportIndex` (>= 1) is the support card; every other slot is a regular card (1-5). */
  cards: TeamCard[]
  supportIndex: number
  guild?: TeamGuild | null
}

export const MAX_REGULAR = 5
export const MIN_CARDS = 2
export const MAX_CARDS = MAX_REGULAR + 1

/** Max card level by rarity. */
export const MAX_LV_BY_RARITY: Readonly<Record<number, number>> = { 1: 50, 2: 55, 3: 60, 4: 65, 5: 70 }
/** Upper bound for `lv` when the roster (and so the card's rarity) is unknown. */
export const MAX_LV_ANY = 70
export const maxLvOf = (rarity: number): number => MAX_LV_BY_RARITY[rarity] ?? MAX_LV_ANY

export const MAX_SA_LV = 100
/** SA Lv step by rarity: <= 3 any Lv, 4 -> 1, 6, 11, ... (step 5), 5 -> 1, 21, 41, ... (step 20); the max (100) is always allowed. */
export const saLvStepOf = (rarity: number): number => (rarity >= 5 ? 20 : rarity === 4 ? 5 : 1)
export const isSaLvAllowed = (rarity: number, v: number): boolean => v === MAX_SA_LV || (v - 1) % saLvStepOf(rarity) === 0

/**
 * Every error code this validator can emit; keep the wiki plugin's messages in sync. The plugin translates these errors
 * with its own strings, so `params` are named like its placeholders (`{id}`, `{max}`, `{min}`, `{slots}`).
 */
export const ERROR_CODES = [
  'payload_invalid',
  'version_invalid',
  'cards_length',
  'card_id_invalid',
  'int_range',
  'lv_seed_needs_max_lv',
  'sa_lv_step',
  'equip_id_invalid',
  'support_required',
  'support_out_of_range',
  'duplicate_card',
  'duplicate_chara',
  'duplicate_equip',
  'unknown_card',
  'unknown_equip',
  'equip_not_allowed',
  'guild_invalid',
  'unknown_guild',
  'dispatch_same_guild',
  'ring_effect_invalid',
] as const

const err = (path: string, code: string, message: string, params?: FieldError['params']): FieldError => ({
  path,
  code,
  message,
  ...(params ? { params } : {}),
})

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

function readInt(errors: FieldError[], path: string, v: unknown, def: number, min: number, max: number): number {
  if (v === undefined || v === null) return def
  if (!isInt(v) || v < min || v > max) {
    errors.push(err(path, 'int_range', `Must be an integer from ${min} to ${max}.`, { min, max }))
    return def
  }
  return v
}

function dupGroups(entries: { slot: number; key: string }[]): number[][] {
  const by = new Map<string, number[]>()
  for (const e of entries) by.set(e.key, [...(by.get(e.key) ?? []), e.slot])
  return [...by.values()].filter((s) => s.length > 1)
}

// ---- roster (api/team-roster.json) ----

interface RosterCard extends CardLike {
  id: number
}
interface RosterEquip extends EquipLike {
  id: number
}

interface ParsedRoster {
  cards: Map<number, RosterCard> | null
  equips: Map<number, RosterEquip> | null
  guilds: Set<number> | null
}

const intList = (v: unknown): number[] => (Array.isArray(v) ? v.filter(isInt) : [])

function parseRoster(roster: unknown): ParsedRoster {
  const out: ParsedRoster = { cards: null, equips: null, guilds: null }
  if (!isObj(roster)) return out
  if (Array.isArray(roster.cards)) {
    const m = new Map<number, RosterCard>()
    for (const e of roster.cards as unknown[]) {
      if (!isObj(e) || !isInt(e.id)) continue
      m.set(e.id, {
        id: e.id,
        element: isInt(e.element) ? e.element : -1,
        weapon: isInt(e.weapon) ? e.weapon : -1,
        rarity: isInt(e.rarity) ? e.rarity : 0,
        chara: isInt(e.chara) ? e.chara : -1,
        guilds: intList(e.guilds),
        schools: intList(e.schools),
        affils: intList(e.affils),
      })
    }
    if (m.size) out.cards = m
  }
  if (Array.isArray(roster.equips)) {
    const m = new Map<number, RosterEquip>()
    for (const e of roster.equips as unknown[]) {
      if (!isObj(e) || !isInt(e.id)) continue
      const limits = Array.isArray(e.limits)
        ? (e.limits as unknown[]).flatMap((l): [number, number][] => (Array.isArray(l) && isInt(l[0]) && isInt(l[1]) ? [[l[0], l[1]]] : []))
        : []
      m.set(e.id, { id: e.id, limits })
    }
    if (m.size) out.equips = m
  }
  if (Array.isArray(roster.guilds)) {
    const s = new Set<number>()
    for (const e of roster.guilds as unknown[]) if (isObj(e) && isInt(e.id)) s.add(e.id)
    if (s.size) out.guilds = s
  }
  return out
}

export function validateTeamPayload(input: unknown, _group: GroupInfo, ctx: ValidateContext = {}): ValidateResult<TeamPayload> {
  const errors: FieldError[] = []
  if (!isObj(input)) return { ok: false, errors: [err('payload', 'payload_invalid', 'The team formation is malformed.')] }
  if (input.v !== 1) errors.push(err('payload.v', 'version_invalid', 'Unsupported payload version.'))
  if (!Array.isArray(input.cards) || input.cards.length < MIN_CARDS || input.cards.length > MAX_CARDS) {
    errors.push(err('payload.cards', 'cards_length', `A team has 1 to ${MAX_REGULAR} cards plus a support card.`, { min: MIN_CARDS, max: MAX_CARDS }))
    return { ok: false, errors }
  }
  const roster = parseRoster(ctx.roster)

  // Support: mandatory, any slot but the first.
  let supportIndex = -1
  const rawSupport = input.supportIndex
  if (rawSupport === undefined || rawSupport === null) {
    errors.push(err('payload.supportIndex', 'support_required', 'Choose a support card.'))
  } else if (!isInt(rawSupport) || rawSupport < 1 || rawSupport >= input.cards.length) {
    errors.push(err('payload.supportIndex', 'support_out_of_range', 'The support card must be in slot 2 or later.', { min: 1, max: input.cards.length - 1 }))
  } else {
    supportIndex = rawSupport
  }

  const cards: TeamCard[] = []
  /** Cards that resolved to a roster entry, by slot (for duplicate and equip checks). */
  const rosterCard = new Map<number, RosterCard>()
  input.cards.forEach((raw: unknown, i: number) => {
    const p = `payload.cards.${i}`
    if (!isObj(raw)) {
      errors.push(err(p, 'payload_invalid', 'The slot is malformed.'))
      return
    }
    let cardId = 0
    if (isInt(raw.cardId) && raw.cardId > 0) cardId = raw.cardId
    else errors.push(err(`${p}.cardId`, 'card_id_invalid', 'Must be a positive integer.'))

    let known: RosterCard | undefined
    if (cardId && roster.cards) {
      known = roster.cards.get(cardId)
      if (known) rosterCard.set(i, known)
      else errors.push(err(`${p}.cardId`, 'unknown_card', 'Unknown card.', { id: cardId }))
    }
    // The max level needs the card's rarity: without the roster accept anything up to the highest cap.
    const maxLv = known ? maxLvOf(known.rarity) : MAX_LV_ANY
    const lv = readInt(errors, `${p}.lv`, raw.lv, maxLv, 1, maxLv)
    const lvSeed = readInt(errors, `${p}.lvSeed`, raw.lvSeed, 0, 0, 20)
    if (known && lvSeed > 0 && lv !== maxLv) {
      errors.push(err(`${p}.lvSeed`, 'lv_seed_needs_max_lv', `The level seed needs the card at its max level (${maxLv}).`, { max: maxLv }))
    }

    const salv = readInt(errors, `${p}.salv`, raw.salv, MAX_SA_LV, 1, MAX_SA_LV)
    // Higher rarities only reach some SA Lvs; checkable once the rarity is known.
    if (known && !isSaLvAllowed(known.rarity, salv)) {
      errors.push(err(`${p}.salv`, 'sa_lv_step', `The SA Lv must be 1 plus a multiple of ${saLvStepOf(known.rarity)}, or ${MAX_SA_LV}.`, { step: saLvStepOf(known.rarity), max: MAX_SA_LV }))
    }

    // Guild dispatch (optional).
    let dispatchGuild: number | undefined
    if (raw.dispatchGuild !== undefined && raw.dispatchGuild !== null) {
      if (isInt(raw.dispatchGuild) && raw.dispatchGuild > 0) {
        dispatchGuild = raw.dispatchGuild
        if (roster.guilds && !roster.guilds.has(dispatchGuild)) {
          errors.push(err(`${p}.dispatchGuild`, 'unknown_guild', 'Unknown guild.', { id: dispatchGuild }))
        } else if (known && known.guilds.includes(dispatchGuild)) {
          errors.push(err(`${p}.dispatchGuild`, 'dispatch_same_guild', 'The card is already in this guild.', { id: dispatchGuild }))
        }
      } else errors.push(err(`${p}.dispatchGuild`, 'guild_invalid', 'Must be a positive integer.'))
    }

    // Ring effect (optional): one of RING_EFFECTS.
    let ringEffect: RingEffect | undefined
    if (raw.ringEffect !== undefined && raw.ringEffect !== null) {
      if (isRingEffect(raw.ringEffect)) ringEffect = raw.ringEffect
      else errors.push(err(`${p}.ringEffect`, 'ring_effect_invalid', `Must be one of ${RING_EFFECTS.join(', ')}.`, { values: RING_EFFECTS.join(',') }))
    }

    let equipId: number | null = null
    if (raw.equipId !== undefined && raw.equipId !== null) {
      if (isInt(raw.equipId) && raw.equipId > 0) equipId = raw.equipId
      else errors.push(err(`${p}.equipId`, 'equip_id_invalid', 'Must be a positive integer.'))
    }
    // Without an equip the level is ignored (and dropped), not validated: the editor does not show it then.
    const equipLv = equipId !== null ? readInt(errors, `${p}.equipLv`, raw.equipLv, 100, 1, 100) : undefined
    if (equipId !== null && roster.equips) {
      const equip = roster.equips.get(equipId)
      if (!equip) errors.push(err(`${p}.equipId`, 'unknown_equip', 'Unknown equipment.', { id: equipId }))
      else if (known && !equipAllowed(equip, known, dispatchGuild)) {
        errors.push(err(`${p}.equipId`, 'equip_not_allowed', 'This card cannot wear this equipment.', { id: equipId }))
      }
    }

    cards.push({
      cardId,
      lv,
      slv: readInt(errors, `${p}.slv`, raw.slv, 100, 1, 100),
      salv,
      lvSeed,
      skillSeed: readInt(errors, `${p}.skillSeed`, raw.skillSeed, 0, 0, 10),
      hpSeed: readInt(errors, `${p}.hpSeed`, raw.hpSeed, 0, 0, 2000),
      atkSeed: readInt(errors, `${p}.atkSeed`, raw.atkSeed, 0, 0, 2000),
      equipId,
      ...(equipLv !== undefined ? { equipLv } : {}),
      ...(dispatchGuild !== undefined ? { dispatchGuild } : {}),
      ...(ringEffect !== undefined ? { ringEffect } : {}),
    })
  })

  // Duplicates among regular cards (the support slot is exempt): one card per character, one of each equipment.
  const regular = cards.map((c, i) => ({ c, i })).filter(({ i }) => i !== supportIndex)
  const charaEntries = regular.flatMap(({ c, i }) => {
    if (!c.cardId) return []
    const k = rosterCard.get(i)
    // With the roster a card stands for its character; without it only identical cards can be told apart.
    return roster.cards ? (k ? [{ slot: i + 1, key: `chara:${k.chara}` }] : []) : [{ slot: i + 1, key: `card:${c.cardId}` }]
  })
  for (const slots of dupGroups(charaEntries)) {
    errors.push(
      roster.cards
        ? err('payload.cards', 'duplicate_chara', `Slots ${slots.join(', ')} use cards of the same character.`, { slots: slots.join(',') })
        : err('payload.cards', 'duplicate_card', `Slots ${slots.join(', ')} use the same card.`, { slots: slots.join(',') }),
    )
  }
  const equipEntries = regular.flatMap(({ c, i }) => (c.equipId === null ? [] : [{ slot: i + 1, key: String(c.equipId) }]))
  for (const slots of dupGroups(equipEntries)) {
    errors.push(err('payload.cards', 'duplicate_equip', `Slots ${slots.join(', ')} use the same equipment.`, { slots: slots.join(',') }))
  }

  // Guild (optional).
  let guild: TeamGuild | undefined
  const rawGuild = input.guild
  if (rawGuild !== undefined && rawGuild !== null) {
    if (!isObj(rawGuild)) errors.push(err('payload.guild', 'guild_invalid', 'The guild is malformed.'))
    else {
      const idOk = isInt(rawGuild.id) && rawGuild.id > 0
      if (!idOk) errors.push(err('payload.guild.id', 'guild_invalid', 'Must be a positive integer.'))
      else if (roster.guilds && !roster.guilds.has(rawGuild.id as number)) {
        errors.push(err('payload.guild.id', 'unknown_guild', 'Unknown guild.', { id: rawGuild.id as number }))
      }
      const g: TeamGuild = {
        id: idOk ? (rawGuild.id as number) : 0,
        atkDef: readInt(errors, 'payload.guild.atkDef', rawGuild.atkDef, 0, 0, 10),
        cp: readInt(errors, 'payload.guild.cp', rawGuild.cp, 0, 0, 10),
        proc: readInt(errors, 'payload.guild.proc', rawGuild.proc, 0, 0, 10),
        base: readInt(errors, 'payload.guild.base', rawGuild.base, 0, 0, 10),
      }
      if (idOk) guild = g
    }
  }

  if (errors.length) return { ok: false, errors }
  return { ok: true, value: { v: 1, cards, supportIndex, ...(guild ? { guild } : {}) } }
}
