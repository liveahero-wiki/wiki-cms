import { describe, expect, it } from 'vitest'
import { joinFrontMatter, splitFrontMatter, startsWithFence } from './frontmatter.ts'

describe('splitFrontMatter', () => {
  it('keeps the fences and the trailing newline exactly, and the body untouched', () => {
    const text = '---\ntitle: A\nlist:\n  - x\n---\n## Body\n\nText\n'
    expect(splitFrontMatter(text)).toEqual({ frontMatter: '---\ntitle: A\nlist:\n  - x\n---\n', body: '## Body\n\nText\n' })
  })

  it('handles CRLF and trailing spaces on the fences', () => {
    const text = '---  \r\ntitle: A\r\n---\t\r\nBody\r\n'
    expect(splitFrontMatter(text)).toEqual({ frontMatter: '---  \r\ntitle: A\r\n---\t\r\n', body: 'Body\r\n' })
  })

  it('an empty front matter and an empty body', () => {
    expect(splitFrontMatter('---\n---\nx')).toEqual({ frontMatter: '---\n---\n', body: 'x' })
    expect(splitFrontMatter('---\na: 1\n---\n')).toEqual({ frontMatter: '---\na: 1\n---\n', body: '' })
  })

  it('a closing fence at the end of the file without a line break belongs to the front matter', () => {
    expect(splitFrontMatter('---\na: 1\n---')).toEqual({ frontMatter: '---\na: 1\n---', body: '' })
  })

  it('stops at the first closing fence; later --- lines are body', () => {
    expect(splitFrontMatter('---\na: 1\n---\ntext\n---\nmore\n')).toEqual({ frontMatter: '---\na: 1\n---\n', body: 'text\n---\nmore\n' })
  })

  it('no front matter: nothing is split off', () => {
    expect(splitFrontMatter('## Heading\n---\nx\n')).toEqual({ frontMatter: '', body: '## Heading\n---\nx\n' })
    expect(splitFrontMatter('')).toEqual({ frontMatter: '', body: '' })
  })

  it('an unclosed fence is not front matter', () => {
    expect(splitFrontMatter('---\na: 1\nno end\n')).toEqual({ frontMatter: '', body: '---\na: 1\nno end\n' })
    expect(splitFrontMatter('---')).toEqual({ frontMatter: '', body: '---' })
  })

  it('a line that merely starts with --- is not a fence', () => {
    expect(splitFrontMatter('---\na: 1\n----\n---\nb')).toEqual({ frontMatter: '---\na: 1\n----\n---\n', body: 'b' })
    expect(startsWithFence('----\n')).toBe(false)
    expect(startsWithFence('--- x\n')).toBe(false)
  })

  it('join is the exact inverse', () => {
    for (const text of ['---\na: 1\n---\nbody\n', '---\r\na: 1\r\n---\r\nbody', 'plain', '---\n---\n', '']) {
      const { frontMatter, body } = splitFrontMatter(text)
      expect(joinFrontMatter(frontMatter, body)).toBe(text)
    }
  })
})
