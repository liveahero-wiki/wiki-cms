import { describe, expect, it } from 'vitest'
import { sql, sqlLiteral } from './sql.ts'

describe('sqlLiteral', () => {
  it('escapes quotes and serializes arrays/objects as JSON strings', () => {
    expect(sqlLiteral("it's")).toBe("'it''s'")
    expect(sqlLiteral("'; DROP TABLE x; --")).toBe("'''; DROP TABLE x; --'")
    expect(sqlLiteral(['a', "b'c"])).toBe(`'["a","b'c"]'`.replace("b'c", "b''c"))
    expect(sqlLiteral(null)).toBe('NULL')
    expect(sqlLiteral(undefined)).toBe('NULL')
    expect(sqlLiteral(12)).toBe('12')
    expect(sqlLiteral(true)).toBe('1')
  })
  it('rejects NUL and non-finite numbers', () => {
    expect(() => sqlLiteral('a\0b')).toThrow()
    expect(() => sqlLiteral(NaN)).toThrow()
    expect(() => sqlLiteral(Infinity)).toThrow()
  })
  it('tagged template escapes every interpolation', () => {
    expect(sql`SELECT * FROM t WHERE a = ${"x'y"} AND b = ${3}`).toBe("SELECT * FROM t WHERE a = 'x''y' AND b = 3")
  })
})
