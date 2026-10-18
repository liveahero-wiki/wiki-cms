import { describe, expect, it } from 'vitest'
import { commitMessage, pullRequestBody, trailerName } from './approve.ts'

describe('trailerName', () => {
  it('strips angle brackets, line breaks and control characters so the trailer cannot be forged', () => {
    expect(trailerName('Alice')).toBe('Alice')
    expect(trailerName('Al<ice>\nCo-authored-by: Mallory <m@evil>')).toBe('Al ice Co-authored-by: Mallory m@evil')
    expect(trailerName('a\r\nb\tc\u0000d')).toBe('a b c d')
    expect(trailerName('  spaced   out  ')).toBe('spaced out')
    expect(trailerName('<>\n')).toBe('Contributor')
    expect(trailerName('')).toBe('Contributor')
    expect(trailerName('x'.repeat(200))).toHaveLength(64)
  })
})

describe('commitMessage', () => {
  it('is the summary, the submission reference and the co-author trailer, separated by blank lines', () => {
    expect(commitMessage('Add usage guide', '0123456789abcdef-rest', { id: 'user_1', displayName: 'Alice' })).toBe(
      'Add usage guide\n\nSubmitted via wiki-cms #01234567\n\nCo-authored-by: Alice <contrib-user_1@users.invalid>',
    )
  })
  it('sanitises the owner id inside the placeholder address and omits the trailer without an owner', () => {
    expect(commitMessage('x y z', 'abcdefgh1', { id: 'a b>c', displayName: 'Bob' })).toContain('<contrib-a-b-c@users.invalid>')
    expect(commitMessage('x y z', 'abcdefgh1', null)).toBe('x y z\n\nSubmitted via wiki-cms #abcdefgh')
  })
})

describe('pullRequestBody', () => {
  it('links back to the submission and ends with the review note', () => {
    const body = pullRequestBody('guide/sale.md', 'sub-123')
    expect(body).toContain('sub-123')
    expect(body).toContain('`guide/sale.md`')
    expect(body.split('\n').at(-1)).toMatch(/maintainer must review/)
  })
})
