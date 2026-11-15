import { describe, expect, it } from 'vitest'
import { ERROR_CODES, MAX_LV_BY_RARITY, validateTeamPayload, type TeamCard } from './validate.ts'
import { housamoTeamFormation } from './index.ts'
import { checkExplanation } from '../../shared/markdown-policy.ts'
import { LANGS } from '../../shared/i18n.ts'
import type { GroupInfo } from '../../core/types-registry.ts'

const group: GroupInfo = { id: 'all', title: 't', url: '/', options: {} }
type R = ReturnType<typeof validateTeamPayload>
const codes = (r: R) => (r.ok ? [] : r.errors.map((e) => e.code))
const card = (cardId: number, extra: Record<string, unknown> = {}) => ({ cardId, ...extra })
/** Valid shape: 2 cards, the second is the support. */
const team = (cards: unknown[], extra: Record<string, unknown> = {}) => ({ v: 1, cards, supportIndex: cards.length - 1, ...extra })
const run = (payload: unknown, roster?: unknown): R => validateTeamPayload(payload, group, { roster })

// Cards: 1/2 same chara 10 (rarity 5), 3 chara 11 (rarity 3), 4 chara 12 (rarity 1), 5 chara 13 (rarity 2), 6 chara 14 (rarity 4), 7 chara 15, 8 chara 16
const roster = {
  version: 'x',
  cards: [
    { id: 1, chara: 10, rarity: 5, element: 1, weapon: 1, guilds: [3], schools: [], affils: [] },
    { id: 2, chara: 10, rarity: 5, element: 2, weapon: 1, guilds: [3], schools: [], affils: [] },
    { id: 3, chara: 11, rarity: 3, element: 1, weapon: 2, guilds: [], schools: [], affils: [] },
    { id: 4, chara: 12, rarity: 1, element: 1, weapon: 2, guilds: [], schools: [], affils: [] },
    { id: 5, chara: 13, rarity: 2, element: 1, weapon: 2, guilds: [], schools: [], affils: [] },
    { id: 6, chara: 14, rarity: 4, element: 1, weapon: 2, guilds: [], schools: [], affils: [] },
    { id: 7, chara: 15, rarity: 5, element: 1, weapon: 2, guilds: [], schools: [], affils: [] },
    { id: 8, chara: 16, rarity: 5, element: 1, weapon: 2, guilds: [], schools: [], affils: [] },
  ],
  equips: [
    { id: 100, rarity: 5, limits: [] },
    { id: 101, rarity: 5, limits: [[1, 1]] }, // element 1 only
    { id: 102, rarity: 4, limits: [[6, 10]] }, // chara 10 only
  ],
  guilds: [{ id: 3 }, { id: 4 }],
}

describe('payload basics', () => {
  it('fills defaults and drops unknown keys', () => {
    const r = run({ v: 1, supportIndex: 1, cards: [{ cardId: 1, junk: 1 }, { cardId: 2 }], extra: 1 })
    expect(r).toEqual({
      ok: true,
      value: {
        v: 1,
        supportIndex: 1,
        cards: [
          { cardId: 1, lv: 70, slv: 100, salv: 100, lvSeed: 0, skillSeed: 0, hpSeed: 0, atkSeed: 0, equipId: null },
          { cardId: 2, lv: 70, slv: 100, salv: 100, lvSeed: 0, skillSeed: 0, hpSeed: 0, atkSeed: 0, equipId: null },
        ],
      },
    })
  })
  it('defaults lv to the rarity max with the roster', () => {
    const r = run(team([card(4), card(3), card(5)]), roster)
    expect(r.ok && r.value.cards.map((c) => c.lv)).toEqual([50, 60, 55])
  })
  it('rejects non-objects, bad version and malformed slots', () => {
    expect(codes(run(null))).toEqual(['payload_invalid'])
    expect(codes(run([]))).toEqual(['payload_invalid'])
    expect(codes(run({ ...team([card(1), card(2)]), v: 2 }))).toContain('version_invalid')
    expect(codes(run(team([card(1), 'x'])))).toContain('payload_invalid')
  })
  it('every error has code, message and path, and every code is listed', () => {
    const r = run({ v: 1, supportIndex: 0, cards: [{ cardId: 'x', lv: 999, equipId: -1 }, {}], guild: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok)
      for (const e of r.errors) {
        expect(e.code && e.message && e.path).toBeTruthy()
        expect(ERROR_CODES).toContain(e.code)
      }
  })
})

describe('cards length and support', () => {
  it('needs 1-5 regular cards plus the support (2-6 slots)', () => {
    expect(run(team([card(1)])).ok).toBe(false)
    expect(codes(run({ v: 1, supportIndex: 0, cards: [card(1)] }))).toEqual(['cards_length'])
    expect(codes(run({ v: 1, supportIndex: 1, cards: [] }))).toEqual(['cards_length'])
    expect(codes(run({ v: 1, supportIndex: 1, cards: 'x' }))).toEqual(['cards_length'])
    expect(run(team([card(1), card(2)])).ok).toBe(true)
    expect(run(team([1, 2, 3, 4, 5, 6].map((n) => card(n)))).ok).toBe(true)
    const seven = run(team([1, 2, 3, 4, 5, 6, 7].map((n) => card(n))))
    expect(codes(seven)).toEqual(['cards_length'])
    if (!seven.ok) expect(seven.errors[0].params).toEqual({ min: 2, max: 6 })
  })
  it('support is mandatory', () => {
    for (const s of [undefined, null]) expect(codes(run({ v: 1, supportIndex: s, cards: [card(1), card(2)] }))).toEqual(['support_required'])
  })
  it('support can be any slot except the first', () => {
    expect(codes(run({ v: 1, supportIndex: 0, cards: [card(1), card(2)] }))).toEqual(['support_out_of_range'])
    for (const bad of [-1, 2, 1.5, '1', 99]) expect(codes(run({ v: 1, supportIndex: bad, cards: [card(1), card(2)] })), String(bad)).toEqual(['support_out_of_range'])
    for (const ok of [1, 2, 3]) expect(run({ v: 1, supportIndex: ok, cards: [card(1), card(2), card(3), card(4)] }).ok).toBe(true)
  })
})

describe('per-card numbers', () => {
  const one = (extra: Record<string, unknown>, rost?: unknown) => run(team([card(3), card(1, extra)]), rost)
  it('card id must be a positive integer', () => {
    for (const bad of [0, -1, 1.5, '1', undefined, null]) expect(codes(run(team([card(1), { cardId: bad }]))), String(bad)).toContain('card_id_invalid')
  })
  it('lv is 1..70 without roster', () => {
    expect(one({ lv: 1 }).ok).toBe(true)
    expect(one({ lv: 70 }).ok).toBe(true)
    for (const bad of [0, 71, 1.5, '5']) expect(codes(one({ lv: bad })), String(bad)).toContain('int_range')
  })
  it('lv max depends on rarity (50/55/60/65/70)', () => {
    const rostered = (cardId: number, lv: number) => run(team([card(3), card(cardId, { lv })]), roster)
    const max: Record<number, number> = { 4: 50, 5: 55, 3: 60, 6: 65, 7: 70 }
    for (const [id, m] of Object.entries(max)) {
      expect(rostered(Number(id), m).ok, `${id} at ${m}`).toBe(true)
      const over = rostered(Number(id), m + 1)
      expect(codes(over), `${id} at ${m + 1}`).toContain('int_range')
      if (!over.ok) expect(over.errors.find((e) => e.code === 'int_range')!.params).toEqual({ min: 1, max: m })
    }
    expect(MAX_LV_BY_RARITY).toEqual({ 1: 50, 2: 55, 3: 60, 4: 65, 5: 70 })
  })
  it('slv / salv are 1..100 (default 100)', () => {
    expect(one({ slv: 1, salv: 100 }).ok).toBe(true)
    for (const f of ['slv', 'salv']) for (const bad of [0, 101, 2.5]) expect(codes(one({ [f]: bad })), `${f} ${bad}`).toContain('int_range')
    const r = one({})
    expect(r.ok && r.value.cards[1]).toMatchObject({ slv: 100, salv: 100 })
  })
  it('salv steps by rarity with the roster (any <= 3, step 5 for 4, step 20 for 5; 100 always)', () => {
    const at = (id: number, salv: number) => codes(run(team([card(id, { salv }), card(4)]), roster))
    for (const v of [1, 21, 41, 61, 81, 100]) expect(at(1, v), `r5 ${v}`).toEqual([])
    for (const v of [2, 20, 22, 99]) expect(at(1, v), `r5 ${v}`).toEqual(['sa_lv_step'])
    for (const v of [1, 6, 11, 96, 100]) expect(at(6, v), `r4 ${v}`).toEqual([])
    for (const v of [2, 5, 97, 99]) expect(at(6, v), `r4 ${v}`).toEqual(['sa_lv_step'])
    for (const v of [1, 2, 55, 99, 100]) expect(at(3, v), `r3 ${v}`).toEqual([])
    for (const v of [1, 2, 99]) expect(at(5, v), `r2 ${v}`).toEqual([])
    const r = run(team([card(1, { salv: 22 }), card(4)]), roster)
    expect(!r.ok && r.errors.find((e) => e.code === 'sa_lv_step')).toMatchObject({ path: 'payload.cards.0.salv', params: { step: 20, max: 100 } })
    // Without the roster the rarity is unknown: any 1..100 passes.
    expect(codes(one({ salv: 22 }))).toEqual([])
  })
  it('seeds: lvSeed 0..20, skillSeed 0..10, hp/atk 0..2000', () => {
    expect(one({ lvSeed: 20, skillSeed: 10, hpSeed: 2000, atkSeed: 2000 }).ok).toBe(true)
    expect(one({ lvSeed: 0, skillSeed: 0, hpSeed: 0, atkSeed: 0 }).ok).toBe(true)
    for (const [f, bad] of [['lvSeed', 21], ['lvSeed', -1], ['skillSeed', 11], ['hpSeed', 2001], ['atkSeed', -1], ['atkSeed', 1.5]] as const) {
      expect(codes(one({ [f]: bad })), `${f} ${bad}`).toContain('int_range')
    }
  })
  it('lvSeed needs lv at the rarity max (with the roster)', () => {
    // card 1 is rarity 5 (max 70)
    expect(one({ lv: 70, lvSeed: 5 }, roster).ok).toBe(true)
    expect(one({ lvSeed: 5 }, roster).ok).toBe(true) // default lv = max
    const r = one({ lv: 69, lvSeed: 1 }, roster)
    expect(codes(r)).toEqual(['lv_seed_needs_max_lv'])
    expect(one({ lv: 69, lvSeed: 0 }, roster).ok).toBe(true)
    // rarity 3 card at 60 is max; at 70 is out of range
    expect(run(team([card(1), card(3, { lv: 60, lvSeed: 20 })]), roster).ok).toBe(true)
    expect(codes(run(team([card(1), card(3, { lv: 59, lvSeed: 1 })]), roster))).toEqual(['lv_seed_needs_max_lv'])
  })
  it('reports the field path with the slot index', () => {
    const r = run(team([card(1), card(2, { hpSeed: 5000 })]))
    expect(!r.ok && r.errors[0].path).toBe('payload.cards.1.hpSeed')
  })
})

describe('equipment', () => {
  it('equipId is optional; equipLv defaults to 100 and exists only with an equip', () => {
    const r = run(team([card(1, { equipId: 100 }), card(2, { equipLv: 40 })]))
    expect(r.ok && r.value.cards[0]).toMatchObject({ equipId: 100, equipLv: 100 })
    expect(r.ok && r.value.cards[1]).toEqual({ cardId: 2, lv: 70, slv: 100, salv: 100, lvSeed: 0, skillSeed: 0, hpSeed: 0, atkSeed: 0, equipId: null })
    expect(r.ok && 'equipLv' in r.value.cards[1]).toBe(false)
    const nul = run(team([card(1, { equipId: null }), card(2)]))
    expect(nul.ok && nul.value.cards[0].equipId).toBeNull()
  })
  it('equipLv is 1..100', () => {
    expect(run(team([card(1, { equipId: 5, equipLv: 1 }), card(2)])).ok).toBe(true)
    for (const bad of [0, 101, 1.5]) expect(codes(run(team([card(1, { equipId: 5, equipLv: bad }), card(2)])))).toContain('int_range')
  })
  it('names error params like the wiki plugin placeholders ({id}, {max})', () => {
    const params = (r: R) => Object.fromEntries(r.ok ? [] : r.errors.map((e) => [e.code, e.params]))
    expect(params(run(team([card(1, { lv: 69, lvSeed: 1 }), card(3)]), roster)).lv_seed_needs_max_lv).toEqual({ max: 70 })
    expect(params(run(team([card(999), card(3)]), roster)).unknown_card).toEqual({ id: 999 })
    expect(params(run(team([card(1, { equipId: 999 }), card(3)]), roster)).unknown_equip).toEqual({ id: 999 })
    expect(params(run(team([card(3, { equipId: 102 }), card(1)]), roster)).equip_not_allowed).toEqual({ id: 102 })
    expect(params(run(team([card(1), card(3)], { guild: { id: 77 } }), roster)).unknown_guild).toEqual({ id: 77 })
  })
  it('ignores equipLv without an equip (like the wiki plugin)', () => {
    const r = run(team([card(1, { equipId: null, equipLv: 0 }), card(2, { equipLv: 500 })]))
    expect(r.ok).toBe(true)
    expect(r.ok && 'equipLv' in r.value.cards[0]).toBe(false)
  })
  it('equipId must be a positive integer', () => {
    for (const bad of [0, -3, 1.5, '1']) expect(codes(run(team([card(1, { equipId: bad }), card(2)]))), String(bad)).toContain('equip_id_invalid')
  })
  it('no duplicate equipment among regular cards; the support may repeat one', () => {
    const dup = run(team([card(1, { equipId: 100 }), card(3, { equipId: 100 }), card(7)]))
    expect(codes(dup)).toEqual(['duplicate_equip'])
    if (!dup.ok) expect(dup.errors[0].params).toEqual({ slots: '1,2' })
    expect(run(team([card(1, { equipId: 100 }), card(3, { equipId: 100 })])).ok).toBe(true) // slot 2 is the support
    expect(run(team([card(1, { equipId: 100 }), card(3, { equipId: 100 })]), roster).ok).toBe(true)
  })
  it('three-way duplicates are one error listing every slot', () => {
    const r = run({ v: 1, supportIndex: 4, cards: [card(1, { equipId: 9 }), card(3, { equipId: 9 }), card(4, { equipId: 9 }), card(5), card(6)] })
    const e = !r.ok && r.errors.filter((x) => x.code === 'duplicate_equip')
    expect(e).toHaveLength(1)
    expect(e && e[0].params).toEqual({ slots: '1,2,3' })
  })
  it('eligibility follows the equip limits (with the roster)', () => {
    // equip 101: element 1 only. card 2 is element 2.
    expect(run(team([card(1, { equipId: 101 }), card(7)]), roster).ok).toBe(true)
    const r = run(team([card(2, { equipId: 101 }), card(7)]), roster)
    expect(codes(r)).toEqual(['equip_not_allowed'])
    expect(!r.ok && r.errors[0].path).toBe('payload.cards.0.equipId')
    // equip 102: chara 10 only
    expect(run(team([card(2, { equipId: 102 }), card(7)]), roster).ok).toBe(true)
    expect(codes(run(team([card(3, { equipId: 102 }), card(7)]), roster))).toEqual(['equip_not_allowed'])
    // no limits = anyone
    expect(run(team([card(3, { equipId: 100 }), card(7)]), roster).ok).toBe(true)
  })
  it('the support card is checked for eligibility too', () => {
    expect(codes(run(team([card(1), card(2, { equipId: 101 })]), roster))).toEqual(['equip_not_allowed'])
  })
  it('eligibility is skipped without the roster', () => {
    expect(run(team([card(2, { equipId: 101 }), card(7)])).ok).toBe(true)
  })
})

describe('duplicate characters', () => {
  it('without the roster only identical cards are detected (duplicate_card)', () => {
    const r = run({ v: 1, supportIndex: 2, cards: [card(1), card(1), card(2)] })
    expect(codes(r)).toEqual(['duplicate_card'])
    expect(!r.ok && r.errors[0].params).toEqual({ slots: '1,2' })
    expect(run({ v: 1, supportIndex: 2, cards: [card(1), card(2), card(3)] }).ok).toBe(true) // 1 and 2 share a chara, unknown here
  })
  it('with the roster, two cards of one character collide (duplicate_chara)', () => {
    const r = run({ v: 1, supportIndex: 2, cards: [card(1), card(2), card(3)] }, roster)
    expect(codes(r)).toEqual(['duplicate_chara'])
    expect(!r.ok && r.errors[0].params).toEqual({ slots: '1,2' })
    expect(codes(run({ v: 1, supportIndex: 2, cards: [card(1), card(1), card(3)] }, roster))).toEqual(['duplicate_chara'])
  })
  it('the support may duplicate a team card or its character', () => {
    expect(run(team([card(1), card(3), card(1)]), roster).ok).toBe(true)
    expect(run(team([card(1), card(3), card(2)]), roster).ok).toBe(true)
    expect(run(team([card(1), card(1)])).ok).toBe(true)
  })
  it('the support does not hide a duplicate among the regular cards', () => {
    expect(codes(run({ v: 1, supportIndex: 3, cards: [card(1), card(2), card(3), card(7)] }, roster))).toEqual(['duplicate_chara'])
  })
})

describe('roster existence', () => {
  it('flags unknown cards and equipment', () => {
    const c = run(team([card(999), card(1)]), roster)
    expect(codes(c)).toEqual(['unknown_card'])
    expect(!c.ok && c.errors[0].path).toBe('payload.cards.0.cardId')
    const e = run(team([card(1, { equipId: 999 }), card(3)]), roster)
    expect(codes(e)).toEqual(['unknown_equip'])
    expect(!e.ok && e.errors[0].path).toBe('payload.cards.0.equipId')
  })
  it('ignores an unusable roster', () => {
    for (const bad of [undefined, null, {}, { cards: [] }, 'x', { cards: 'nope' }]) expect(run(team([card(999), card(1)]), bad).ok).toBe(true)
  })
})

describe('guild', () => {
  const g = (guild: unknown, rost?: unknown) => run(team([card(1), card(3)], { guild }), rost)
  it('is optional', () => {
    expect(g(undefined).ok).toBe(true)
    expect(g(null).ok).toBe(true)
    const r = g(undefined)
    expect(r.ok && 'guild' in r.value).toBe(false)
  })
  it('fills level defaults of 0 and keeps the levels (0..10)', () => {
    expect(g({ id: 3 })).toMatchObject({ ok: true, value: { guild: { id: 3, atkDef: 0, cp: 0, proc: 0, base: 0 } } })
    expect(g({ id: 3, atkDef: 10, cp: 1, proc: 5, base: 0 })).toMatchObject({ ok: true, value: { guild: { id: 3, atkDef: 10, cp: 1, proc: 5, base: 0 } } })
  })
  it('levels beyond 0..10 are rejected', () => {
    for (const f of ['atkDef', 'cp', 'proc', 'base']) for (const bad of [-1, 11, 1.5]) expect(codes(g({ id: 3, [f]: bad })), `${f} ${bad}`).toContain('int_range')
  })
  it('malformed guilds are rejected', () => {
    for (const bad of ['x', 5, [], { id: 0 }, { id: 'a' }, {}]) expect(codes(g(bad)), JSON.stringify(bad)).toContain('guild_invalid')
  })
  it('checks the guild against the roster', () => {
    expect(g({ id: 4 }, roster).ok).toBe(true)
    const r = g({ id: 77 }, roster)
    expect(codes(r)).toEqual(['unknown_guild'])
    expect(!r.ok && r.errors[0].path).toBe('payload.guild.id')
    expect(g({ id: 77 }).ok).toBe(true)
  })
})

describe('type def', () => {
  const def = housamoTeamFormation
  it('has the expected identity and limits', () => {
    expect(def.id).toBe('housamo-team-formation')
    expect(def.rosterPath).toBe('/api/team-roster.json')
    expect(def.maxPayloadBytes).toBe(4096)
    expect(def.title).toMatchObject({ required: true, minLength: 4, maxLength: 50 })
    expect(def.langs.map((l) => l.value)).toEqual(['en', 'zh-Hans', 'zh-Hant', 'ja'])
    expect(def.moderationText!({ v: 1, supportIndex: 1, cards: [{}, {}, {}] as TeamCard[] })).toBe('team of 3 cards')
  })
  it('has explanation templates for all langs that pass the markdown policy', () => {
    for (const lang of LANGS) {
      const t = def.explanation!.template[lang]
      expect(t, lang).toBeTruthy()
      expect(checkExplanation(t), lang).toEqual([])
      expect(t.length).toBeLessThan(def.explanation!.maxLength)
    }
  })
  it('has title and tag labels for all langs', () => {
    for (const lang of LANGS) {
      expect(def.title!.label[lang], lang).toBeTruthy()
      expect(def.title!.placeholder![lang], lang).toBeTruthy()
    }
    for (const tag of def.tags) {
      for (const lang of LANGS) expect(tag.label[lang], `${tag.key}.${lang}`).toBeTruthy()
      for (const o of tag.options) for (const lang of LANGS) expect(o.label[lang], `${o.value}.${lang}`).toBeTruthy()
    }
  })
  it('tags: teamType (default manual) and successRate', () => {
    expect(def.tags.map((t) => t.key)).toEqual(['teamType', 'successRate'])
    const tt = def.tags[0]
    expect(tt.default).toBe('manual')
    expect(tt.required).toBe(true)
    expect(tt.options.map((o) => o.value)).toEqual(['manual', 'auto'])
    expect(def.tags[1].options.map((o) => o.value)).toEqual(['high', 'medium', 'low'])
    expect(def.tags[1].required).toBe(true)
  })
  it('the largest valid team fits the payload cap', () => {
    const full = {
      v: 1,
      supportIndex: 5,
      guild: { id: 24, atkDef: 10, cp: 10, proc: 10, base: 10 },
      cards: Array.from({ length: 6 }, (_, i) => ({ cardId: 1000000 + i, lv: 70, slv: 100, salv: 100, lvSeed: 20, skillSeed: 10, hpSeed: 2000, atkSeed: 2000, equipId: 1000 + i, equipLv: 100 })),
    }
    expect(JSON.stringify(full).length).toBeLessThan(def.maxPayloadBytes)
  })
})
