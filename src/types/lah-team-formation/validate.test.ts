import { describe, expect, it } from 'vitest'
import { parseTargets, supportMode, validateTeamPayload, type TeamSlot } from './validate.ts'
import { lahTeamFormation } from './index.ts'
import { checkExplanation } from '../../shared/markdown-policy.ts'
import { LANGS } from '../../shared/i18n.ts'
import type { GroupInfo } from '../../core/types-registry.ts'

const group = (options: Record<string, unknown> = {}): GroupInfo => ({ id: 'g', title: 't', url: '/', options })
const slot = (stockId: number, extra: Partial<TeamSlot> = {}) => ({ stockId, ...extra })
const codes = (r: ReturnType<typeof validateTeamPayload>) => (r.ok ? [] : r.errors.map((e) => e.code))

describe('payload basics', () => {
  it('fills defaults and drops unknown keys', () => {
    const r = validateTeamPayload({ v: 1, supportIndex: 0, heroes: [{ stockId: 1, junk: 1 }], extra: 1 }, group())
    expect(r).toEqual({
      ok: true,
      value: {
        v: 1,
        supportIndex: 0,
        heroes: [{ stockId: 1, lv: 60, plv: 0, fans: 0, engrave: 0, bloom: false, skillTree: false, active: null, passives: [] }],
      },
    })
  })
  it('rejects bad version, empty and >5 slots', () => {
    expect(codes(validateTeamPayload({ v: 2, heroes: [slot(1)] }, group({ support: false })))).toContain('version_invalid')
    expect(codes(validateTeamPayload({ v: 1, heroes: [] }, group()))).toContain('heroes_length')
    const six = [1, 2, 3, 4, 5, 6].map((n) => slot(n))
    expect(codes(validateTeamPayload({ v: 1, supportIndex: 0, heroes: six }, group()))).toContain('heroes_length')
  })
  it('range checks numbers (engrave default 0, up to 1000)', () => {
    const ok = validateTeamPayload({ v: 1, heroes: [slot(1, { lv: 60, plv: 100, fans: 1000, engrave: 1000 })] }, group({ support: false }))
    expect(ok.ok).toBe(true)
    for (const bad of [{ lv: 0 }, { lv: 61 }, { plv: 101 }, { fans: -1 }, { engrave: 1.5 }, { engrave: 1001 }]) {
      const r = validateTeamPayload({ v: 1, heroes: [slot(1, bad as Partial<TeamSlot>)] }, group({ support: false }))
      expect(codes(r)).toContain('int_range')
    }
  })
  it('rejects non-positive stock ids and non-boolean flags', () => {
    expect(codes(validateTeamPayload({ v: 1, heroes: [slot(0)] }, group({ support: false })))).toContain('stock_id_invalid')
    expect(codes(validateTeamPayload({ v: 1, heroes: [{ stockId: 1, bloom: 'yes' }] }, group({ support: false })))).toContain('bool_invalid')
  })
  it('own hero as active sidekick is rejected', () => {
    const r = validateTeamPayload({ v: 1, heroes: [slot(10011, { active: 10011 })] }, group({ support: false }))
    expect(codes(r)).toContain('active_same_as_hero')
  })
  it('every error has code, message and path', () => {
    const r = validateTeamPayload({ v: 1, heroes: [{ stockId: 'x', lv: 99, passives: [1, 1, 1] }] }, group())
    expect(r.ok).toBe(false)
    if (!r.ok) for (const e of r.errors) expect(e.code && e.message && e.path).toBeTruthy()
  })
})

describe('passives', () => {
  it('limits by bloom and forbids duplicates within a slot', () => {
    const g = group({ support: false })
    expect(codes(validateTeamPayload({ v: 1, heroes: [slot(1, { passives: [2, 3, 4] })] }, g))).toContain('passives_too_many')
    expect(validateTeamPayload({ v: 1, heroes: [slot(1, { bloom: true, passives: [2, 3, 4] })] }, g).ok).toBe(true)
    expect(codes(validateTeamPayload({ v: 1, heroes: [slot(1, { bloom: true, passives: [2, 3, 4, 5] })] }, g))).toContain('passives_too_many')
    expect(codes(validateTeamPayload({ v: 1, heroes: [slot(1, { passives: [2, 2] })] }, g))).toContain('passives_duplicate')
  })
  it('skill tree requires bloom', () => {
    const g = group({ support: false })
    expect(codes(validateTeamPayload({ v: 1, heroes: [slot(1, { skillTree: true })] }, g))).toContain('bloom_required')
    expect(validateTeamPayload({ v: 1, heroes: [slot(1, { skillTree: true, bloom: true })] }, g).ok).toBe(true)
  })
  it('allows the same passive across different slots', () => {
    const r = validateTeamPayload({ v: 1, heroes: [slot(1, { passives: [9] }), slot(2, { passives: [9] })] }, group({ support: false }))
    expect(r.ok).toBe(true)
  })
})

describe('support rule (group-driven)', () => {
  const dupHero = [slot(1), slot(2), slot(1)]
  it('support=true (default) requires supportIndex', () => {
    expect(codes(validateTeamPayload({ v: 1, heroes: [slot(1)] }, group()))).toContain('support_required')
    expect(codes(validateTeamPayload({ v: 1, supportIndex: null, heroes: [slot(1)] }, group({ support: true })))).toContain('support_required')
    expect(codes(validateTeamPayload({ v: 1, supportIndex: 1, heroes: [slot(1)] }, group()))).toContain('support_out_of_range')
    expect(codes(validateTeamPayload({ v: 1, supportIndex: -1, heroes: [slot(1)] }, group()))).toContain('support_out_of_range')
    expect(codes(validateTeamPayload({ v: 1, supportIndex: 0.5, heroes: [slot(1)] }, group()))).toContain('support_out_of_range')
  })
  it('support slot may duplicate a hero and/or active', () => {
    const r = validateTeamPayload({ v: 1, supportIndex: 2, heroes: [slot(1, { active: 5 }), slot(2), slot(1, { active: 5 })] }, group())
    expect(r.ok).toBe(true)
  })
  it('duplicates among non-support slots are rejected', () => {
    expect(codes(validateTeamPayload({ v: 1, supportIndex: 1, heroes: dupHero }, group()))).toContain('duplicate_hero')
    const act = validateTeamPayload({ v: 1, supportIndex: 2, heroes: [slot(1, { active: 5 }), slot(2, { active: 5 }), slot(3)] }, group())
    expect(codes(act)).toContain('duplicate_active')
  })
  it('two separate duplicate pairs are rejected', () => {
    const r = validateTeamPayload({ v: 1, supportIndex: 4, heroes: [slot(1), slot(1), slot(2), slot(2), slot(3)] }, group())
    expect(codes(r).filter((c) => c === 'duplicate_hero')).toHaveLength(2)
  })
  it('support=false rejects any non-null supportIndex and any duplicate', () => {
    const g = group({ support: false })
    expect(codes(validateTeamPayload({ v: 1, supportIndex: 0, heroes: [slot(1)] }, g))).toContain('support_not_allowed')
    expect(validateTeamPayload({ v: 1, supportIndex: null, heroes: [slot(1)] }, g).ok).toBe(true)
    expect(validateTeamPayload({ v: 1, heroes: [slot(1)] }, g).ok).toBe(true)
    expect(codes(validateTeamPayload({ v: 1, heroes: dupHero }, g))).toContain('duplicate_hero')
    expect(codes(validateTeamPayload({ v: 1, heroes: [slot(1, { active: 5 }), slot(2, { active: 5 })] }, g))).toContain('duplicate_active')
  })
  it('null actives never count as duplicates', () => {
    expect(validateTeamPayload({ v: 1, heroes: [slot(1), slot(2)] }, group({ support: false })).ok).toBe(true)
  })
})

describe('focus rule', () => {
  const heroFocus = group({ support: true, focus: { kind: 'hero', stockId: 10251 } })
  const sideFocus = group({ support: true, focus: { kind: 'sidekick', stockId: 10251 } })
  it('hero focus: satisfied by a normal slot and by the support slot', () => {
    expect(validateTeamPayload({ v: 1, supportIndex: 1, heroes: [slot(10251), slot(2)] }, heroFocus).ok).toBe(true)
    expect(validateTeamPayload({ v: 1, supportIndex: 1, heroes: [slot(2), slot(10251)] }, heroFocus).ok).toBe(true)
    const miss = validateTeamPayload({ v: 1, supportIndex: 0, heroes: [slot(2)] }, heroFocus)
    expect(codes(miss)).toContain('focus_missing')
    if (!miss.ok) expect(miss.errors.find((e) => e.code === 'focus_missing')!.params).toEqual({ kind: 'hero', stockId: 10251 })
  })
  it('sidekick focus: satisfied by active or passive; hero id does not satisfy it', () => {
    expect(validateTeamPayload({ v: 1, supportIndex: 0, heroes: [slot(1, { active: 10251 })] }, sideFocus).ok).toBe(true)
    expect(validateTeamPayload({ v: 1, supportIndex: 0, heroes: [slot(1, { passives: [10251] })] }, sideFocus).ok).toBe(true)
    expect(codes(validateTeamPayload({ v: 1, supportIndex: 0, heroes: [slot(10251)] }, sideFocus))).toContain('focus_missing')
    expect(codes(validateTeamPayload({ v: 1, supportIndex: 0, heroes: [slot(1, { active: 10251 })] }, heroFocus))).toContain('focus_missing')
  })
  it('no focus option means no rule; malformed focus is ignored', () => {
    expect(validateTeamPayload({ v: 1, supportIndex: 0, heroes: [slot(2)] }, group()).ok).toBe(true)
    for (const focus of [{ kind: 'x', stockId: 1 }, { kind: 'hero', stockId: 1.5 }, 'hero', 5]) {
      expect(validateTeamPayload({ v: 1, supportIndex: 0, heroes: [slot(2)] }, group({ focus })).ok).toBe(true)
    }
  })
})

describe('same-character sidekick', () => {
  const roster = {
    heroes: [{ stockId: 10, characterId: 1 }, { stockId: 11, characterId: 1 }, { stockId: 20, characterId: 2 }],
    sidekicks: [{ stockId: 30, characterId: 1 }, { stockId: 31, characterId: 2 }, { stockId: 32, characterId: 3 }],
  }
  const g = group({ support: false })
  const run = (s: Partial<TeamSlot>) => validateTeamPayload({ v: 1, heroes: [slot(10, s)] }, g, { roster })
  const where = (r: ReturnType<typeof validateTeamPayload>) => (r.ok ? [] : r.errors.map((e) => [e.code, e.path]))

  it('rejects an active sidekick of the hero’s own character, at the active path', () => {
    expect(where(run({ active: 30 }))).toEqual([['sidekick_same_character', 'payload.heroes.0.active']])
  })
  it('rejects a passive sidekick of the hero’s own character, at that passive’s path', () => {
    expect(where(run({ passives: [32, 30] }))).toEqual([['sidekick_same_character', 'payload.heroes.0.passives.1']])
  })
  it('allows sidekicks of other characters, and skips the check without a roster', () => {
    expect(run({ active: 31, passives: [32] }).ok).toBe(true)
    expect(validateTeamPayload({ v: 1, heroes: [slot(10, { active: 30 })] }, g).ok).toBe(true)
  })
  it('does not double-report the plain same-card active', () => {
    const r = validateTeamPayload({ v: 1, heroes: [slot(10, { active: 10 })] }, g, { roster: { heroes: roster.heroes, sidekicks: [{ stockId: 10, characterId: 1 }] } })
    expect(codes(r)).toEqual(['active_same_as_hero'])
  })
})

describe('roster soft check', () => {
  const roster = { heroes: [{ stockId: 1 }, { stockId: 2 }], sidekicks: [{ stockId: 1 }, { stockId: 9 }] }
  const g = group({ support: false })
  it('rejects unknown ids only when a roster is supplied', () => {
    const p = { v: 1, heroes: [slot(3, { active: 4, passives: [9, 8] })] }
    expect(validateTeamPayload(p, g).ok).toBe(true)
    const r = validateTeamPayload(p, g, { roster })
    expect(codes(r)).toEqual(['unknown_hero', 'unknown_sidekick', 'unknown_sidekick'])
    expect(validateTeamPayload({ v: 1, heroes: [slot(2, { active: 9 })] }, g, { roster }).ok).toBe(true)
    expect(validateTeamPayload(p, g, { roster: { nonsense: true } }).ok).toBe(true)
  })
  it('passives may be roster items (itemId), skipping the same-character rule; unknown ids still fail', () => {
    const withItems = { heroes: [{ stockId: 2, characterId: 1 }], sidekicks: [{ stockId: 9, characterId: 1 }], items: [{ itemId: 65 }, { itemId: 66 }] }
    const run = (passives: number[], r: unknown = withItems) => validateTeamPayload({ v: 1, heroes: [slot(2, { passives })] }, g, { roster: r })
    expect(run([65, 66]).ok).toBe(true)
    expect(codes(run([65, 67]))).toEqual(['unknown_sidekick'])
    // a roster from before items existed cannot vouch for an item id
    expect(codes(run([65], { heroes: withItems.heroes, sidekicks: withItems.sidekicks }))).toEqual(['unknown_sidekick'])
  })
  it('the same item is a duplicate within one hero but fine across heroes', () => {
    const items = { heroes: [{ stockId: 1 }, { stockId: 2 }], sidekicks: [{ stockId: 9 }], items: [{ itemId: 65 }] }
    expect(codes(validateTeamPayload({ v: 1, heroes: [slot(1, { passives: [65, 65] })] }, g, { roster: items }))).toEqual(['passives_duplicate'])
    expect(validateTeamPayload({ v: 1, heroes: [slot(1, { passives: [65, 9] }), slot(2, { passives: [65] })] }, g, { roster: items }).ok).toBe(true)
  })
})

describe('type def completeness', () => {
  it('has explanation templates for all langs that pass the markdown policy', () => {
    for (const lang of LANGS) {
      const t = lahTeamFormation.explanation.template[lang]
      expect(t, lang).toBeTruthy()
      expect(checkExplanation(t), lang).toEqual([])
      expect(t.length).toBeLessThan(lahTeamFormation.explanation.maxLength)
    }
  })
  it('has tag labels for all langs', () => {
    for (const tag of lahTeamFormation.tags) {
      for (const lang of LANGS) expect(tag.label[lang], `${tag.key}.${lang}`).toBeTruthy()
      for (const o of tag.options) for (const lang of LANGS) expect(o.label[lang], `${o.value}.${lang}`).toBeTruthy()
    }
  })
})

describe('support modes', () => {
  const opt = group({ support: 'optional' })
  it('supportMode maps the group option', () => {
    expect(supportMode({})).toBe('required')
    expect(supportMode({ support: true })).toBe('required')
    expect(supportMode({ support: false })).toBe('none')
    expect(supportMode({ support: 'optional' })).toBe('optional')
    expect(supportMode({ support: 'whatever' })).toBe('required')
  })
  it('optional: a team may omit the support or name a valid slot', () => {
    expect(validateTeamPayload({ v: 1, heroes: [slot(1), slot(2)] }, opt).ok).toBe(true)
    expect(validateTeamPayload({ v: 1, supportIndex: null, heroes: [slot(1), slot(2)] }, opt).ok).toBe(true)
    expect(validateTeamPayload({ v: 1, supportIndex: 1, heroes: [slot(1), slot(2)] }, opt).ok).toBe(true)
    expect(codes(validateTeamPayload({ v: 1, supportIndex: 2, heroes: [slot(1), slot(2)] }, opt))).toEqual(['support_out_of_range'])
  })
  it('optional: the support slot is still exempt from the duplicate check, a non-support slot is not', () => {
    expect(validateTeamPayload({ v: 1, supportIndex: 1, heroes: [slot(1), slot(1)] }, opt).ok).toBe(true)
    expect(codes(validateTeamPayload({ v: 1, heroes: [slot(1), slot(1)] }, opt))).toEqual(['duplicate_hero'])
  })
})

describe('targets', () => {
  const targets = [
    { id: 'quest-616001', label: { en: 'Simulator (SSS)', ja: 'シミュレーター' }, url: '/guide/challenge_simulator/' },
    { id: 'rogue-2609', label: { en: 'Unexplored boss' }, retired: true },
  ]
  const g = group({ support: 'optional', targets })
  const run = (target: unknown, gg = g) => validateTeamPayload({ v: 1, heroes: [slot(1)], ...(target === undefined ? {} : { target }) }, gg)

  it('parseTargets keeps valid entries and drops malformed or duplicate ones', () => {
    const parsed = parseTargets({
      targets: [
        ...targets,
        { id: 'quest-616001', label: { en: 'dup' } },
        { id: 'Bad Id', label: { en: 'x' } },
        { id: 'no-label' },
        { id: 'empty-label', label: { en: ' ' } },
        'junk',
      ],
    })
    expect(parsed.map((t) => t.id)).toEqual(['quest-616001', 'rogue-2609'])
    expect(parsed[1]!.retired).toBe(true)
    expect(parseTargets({})).toEqual([])
    expect(parseTargets({ targets: 'x' })).toEqual([])
  })
  it('target is optional: absent and null mean general purpose and are not stored', () => {
    for (const t of [undefined, null]) {
      const r = run(t)
      expect(r.ok && 'target' in r.value).toBe(false)
    }
  })
  it('accepts a listed target, including a retired one, and stores it', () => {
    const r = run('quest-616001')
    expect(r.ok && r.value.target).toBe('quest-616001')
    expect(run('rogue-2609').ok).toBe(true)
  })
  it('rejects unknown ids, non-strings and any target when the group lists none', () => {
    for (const bad of ['quest-1', 5, '', {}]) expect(codes(run(bad)), String(bad)).toEqual(['target_unknown'])
    expect(codes(run('quest-616001', group({ support: 'optional' })))).toEqual(['target_unknown'])
    const r = run('quest-1')
    if (!r.ok) expect(r.errors[0]!.path).toBe('payload.target')
  })
})

describe('type def title and tags', () => {
  it('requires a title of 4–50 characters and has a default for the team type', () => {
    expect(lahTeamFormation.title).toMatchObject({ required: true, minLength: 4, maxLength: 50 })
    for (const lang of LANGS) expect(lahTeamFormation.title!.label[lang], lang).toBeTruthy()
    const teamType = lahTeamFormation.tags.find((t) => t.key === 'teamType')!
    expect(teamType.default).toBe('manual')
    expect(teamType.options.map((o) => o.value)).toContain(teamType.default)
    expect(lahTeamFormation.tags.map((t) => t.key)).toEqual(['teamType', 'successRate'])
  })
})
