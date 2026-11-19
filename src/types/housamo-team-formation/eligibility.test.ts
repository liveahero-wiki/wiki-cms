import { describe, expect, it } from 'vitest'
import { equipAllowed, type CardLike } from './eligibility.ts'

const card = (extra: Partial<CardLike> = {}): CardLike => ({ element: 1, weapon: 2, rarity: 4, chara: 10, guilds: [3], schools: [5], affils: [7], ...extra })
const limits = (...l: [number, number][]) => ({ limits: l })

describe('equipAllowed', () => {
  it('no limits = any card', () => expect(equipAllowed(limits(), card())).toBe(true))
  it('type 1 element', () => {
    expect(equipAllowed(limits([1, 1]), card())).toBe(true)
    expect(equipAllowed(limits([1, 2]), card())).toBe(false)
  })
  it('type 2 weapon', () => {
    expect(equipAllowed(limits([2, 2]), card())).toBe(true)
    expect(equipAllowed(limits([2, 1]), card())).toBe(false)
  })
  it('type 5 rarity is "<="', () => {
    expect(equipAllowed(limits([5, 4]), card({ rarity: 4 }))).toBe(true)
    expect(equipAllowed(limits([5, 4]), card({ rarity: 3 }))).toBe(true)
    expect(equipAllowed(limits([5, 4]), card({ rarity: 5 }))).toBe(false)
  })
  it('type 6 chara', () => {
    expect(equipAllowed(limits([6, 10]), card())).toBe(true)
    expect(equipAllowed(limits([6, 11]), card())).toBe(false)
  })
  it('types 7, 8, 9 guild / school / affiliation', () => {
    expect(equipAllowed(limits([7, 3]), card())).toBe(true)
    expect(equipAllowed(limits([7, 4]), card())).toBe(false)
    expect(equipAllowed(limits([8, 5]), card())).toBe(true)
    expect(equipAllowed(limits([8, 6]), card({ schools: [] }))).toBe(false)
    expect(equipAllowed(limits([9, 7]), card())).toBe(true)
    expect(equipAllowed(limits([9, 8]), card())).toBe(false)
    // Master_Equip affiliation ids carry a 1000 offset
    expect(equipAllowed(limits([9, 1007]), card())).toBe(true)
    expect(equipAllowed(limits([9, 1008]), card())).toBe(false)
  })
  it('limits are OR-ed', () => {
    expect(equipAllowed(limits([1, 9], [6, 10]), card())).toBe(true)
    expect(equipAllowed(limits([1, 9], [6, 99]), card())).toBe(false)
  })
  it('unknown limit types match nothing', () => {
    expect(equipAllowed(limits([42, 1]), card())).toBe(false)
    expect(equipAllowed(limits([42, 1], [1, 1]), card())).toBe(true)
  })
})
