import { describe, expect, it } from 'vitest'
import { lahPageEdit } from './index.ts'
import { AFTER_MAX_CHARS, isEditablePath, validatePageEdit } from './validate.ts'

const SHA = 'a'.repeat(40)
const ok = (over: Record<string, unknown> = {}) => ({ path: '_charas/ryekie.md', baseSha: SHA, after: '## Notes\nHello\n', summary: 'Add usage guide', ...over })
const run = (over: Record<string, unknown> = {}) => validatePageEdit(ok(over))
const codes = (r: ReturnType<typeof validatePageEdit>) => (r.ok ? [] : r.errors.map((e) => `${e.path}:${e.code}`))

describe('type definition', () => {
  it('matches the contract', () => {
    expect(lahPageEdit).toMatchObject({ id: 'lah-page-edit', accountOnly: true, editable: false, publicList: false, tags: [], langs: [{ value: 'en', label: 'English' }], maxBodyBytes: 512 * 1024 })
    expect(lahPageEdit.title).toBeUndefined()
    expect(lahPageEdit.explanation).toBeUndefined()
    expect(lahPageEdit.demoUrl).toBeUndefined()
    // a page at the character cap must fit even as 3-byte CJK text (body is measured in bytes)
    const cjk = JSON.stringify({ path: '_charas/a.md', baseSha: 'a'.repeat(40), after: '字'.repeat(AFTER_MAX_CHARS), summary: 'summary' })
    expect(new TextEncoder().encode(cjk).length).toBeLessThan(lahPageEdit.maxBodyBytes!)
    expect(cjk.length).toBeLessThan(lahPageEdit.maxPayloadBytes)
    expect(typeof lahPageEdit.onApprove).toBe('function')
  })
})

describe('payload basics', () => {
  it('accepts a good edit and keeps only the known keys', () => {
    expect(validatePageEdit({ ...ok(), extra: 1 })).toEqual({ ok: true, value: ok() })
  })
  it('rejects non-objects', () => {
    for (const v of [null, undefined, 'x', 1, [], [ok()]]) expect(codes(validatePageEdit(v))).toEqual([':payload_invalid'])
  })
  it('reports every bad field at once', () => {
    expect(codes(validatePageEdit({ path: 'x', baseSha: 'y', after: 1, summary: '' }))).toEqual(['path:path_not_editable', 'baseSha:base_sha_invalid', 'after:after_invalid', 'summary:summary_length'])
  })
})

describe('path', () => {
  it.each(['_charas/ryekie.md', '_events/2204aprilfool.md', '_main_quests/main_1.md', 'guide/sale.md', 'chara_quests.md', 'mobs.md', '_charas/a-b_c.d.md'])('allows %s', (p) => {
    expect(isEditablePath(p)).toBe(true)
    expect(run({ path: p }).ok).toBe(true)
  })
  it.each([
    '_statuses/x.md',
    '_posts/2020-01-01-x.md',
    '_layouts/default.html',
    '_includes/item.html',
    'index.md',
    'README.md',
    '_charas/x.html',
    '_charas/sub/x.md',
    'guide/sub/x.md',
    '_charas/.md',
    '_charas/.hidden.md',
    '_charas/..md',
    '_charas/a..b.md',
    '../_charas/x.md',
    '_charas/../mobs.md',
    '/_charas/x.md',
    '_charas\\x.md',
    '_charas/x y.md',
    '_charas/x%2e.md',
    '_charas/ã.md',
    '_charas/x.md\n',
    '_charas/x.md/',
    ' mobs.md',
    '.github/workflows/x.md',
    'mobs.md.md',
    'Mobs.md',
    'guide/',
    '',
  ])('rejects %j', (p) => {
    expect(isEditablePath(p)).toBe(false)
    expect(codes(run({ path: p }))).toEqual(['path:path_not_editable'])
  })
  it('rejects a non-string path', () => {
    expect(codes(run({ path: 5 }))).toEqual(['path:path_not_editable'])
    expect(codes(run({ path: undefined }))).toEqual(['path:path_not_editable'])
  })
})

describe('baseSha', () => {
  it('needs 40 hex characters (lower-cased)', () => {
    expect(run({ baseSha: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01' })).toMatchObject({ ok: true, value: { baseSha: 'abcdef0123456789abcdef0123456789abcdef01' } })
    for (const bad of ['', 'a'.repeat(39), 'a'.repeat(41), 'g'.repeat(40), ' ' + 'a'.repeat(40), 5, null]) expect(codes(run({ baseSha: bad }))).toEqual(['baseSha:base_sha_invalid'])
  })
})

describe('after', () => {
  it('must be a string; empty is fine', () => {
    expect(run({ after: '' }).ok).toBe(true)
    for (const bad of [1, null, undefined, ['x']]) expect(codes(run({ after: bad }))).toEqual(['after:after_invalid'])
  })
  it('is capped at 120000 characters', () => {
    expect(run({ after: 'x'.repeat(AFTER_MAX_CHARS) }).ok).toBe(true)
    expect(codes(run({ after: 'x'.repeat(AFTER_MAX_CHARS + 1) }))).toEqual(['after:after_too_long'])
  })
  it('must not contain NUL', () => {
    expect(codes(run({ after: 'a\u0000b' }))).toEqual(['after:after_nul'])
  })
  it('must not start with a front matter fence', () => {
    for (const bad of ['---\ntitle: x\n---\nbody', '---\n', '---', '---  \r\nx', '---\t\nx']) expect(codes(run({ after: bad }))).toEqual(['after:after_front_matter'])
  })
  it('a fence later in the text, or a longer dash run, is allowed', () => {
    for (const fine of ['text\n---\nmore', '----\nx', '--- x\n', '\n---\nx', '-- -\n']) expect(run({ after: fine }).ok).toBe(true)
  })
  it('keeps Liquid, HTML and line breaks verbatim (the wiki CI guards those)', () => {
    const body = '{% for i in x %}\r\n<table></table>\n{% endfor %}'
    expect(run({ after: body })).toMatchObject({ ok: true, value: { after: body } })
  })
})

describe('summary', () => {
  it('is trimmed and 3 to 120 characters', () => {
    expect(run({ summary: '  Fix typo  ' })).toMatchObject({ ok: true, value: { summary: 'Fix typo' } })
    expect(run({ summary: 'abc' }).ok).toBe(true)
    expect(run({ summary: 'x'.repeat(120) }).ok).toBe(true)
    for (const bad of ['', 'ab', '  ab  ', 'x'.repeat(121), 5, null, undefined]) expect(codes(run({ summary: bad }))).toEqual(['summary:summary_length'])
  })
  it('must be a single line of plain text', () => {
    for (const bad of ['two\nlines', 'cr\rhere', 'tab\there', 'nul\u0000x', 'bell\u0007x', 'del\u007fx', 'sep\u{2028}x', 'par\u{2029}x', 'c1\u{85}x', 'in\nside']) expect(codes(run({ summary: bad }))).toEqual(['summary:summary_plain'])
  })
  it('allows ordinary punctuation and non-Latin text', () => {
    expect(run({ summary: 'Add 「使用ガイド」 & notes (v2): ok?' }).ok).toBe(true)
  })
})
