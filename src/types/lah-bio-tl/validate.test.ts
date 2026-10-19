import { describe, expect, it } from 'vitest'
import { lahBioTl } from './index.ts'
import { validateBioPayload } from './validate.ts'

const payload = (over: Record<string, unknown> = {}) => ({ key: 'DETAIL_CEPH_H01', base: 'Old text', text: 'New text', ...over })
const roster = { version: '1', bios: { DETAIL_CEPH_H01: { jp: 'x' }, bio_s01: { jp: 'y', en: 'z' } } }

const run = (input: unknown, r?: unknown, lang?: string) => validateBioPayload(input, undefined, { roster: r, lang })
const errs = (r: ReturnType<typeof run>) => (r.ok ? [] : r.errors.map((e) => `${e.path}:${e.code}`))

describe('lah-bio-tl payload', () => {
  it('accepts a valid payload and keeps only known fields', () => {
    expect(run({ ...payload({ note: 'n' }), junk: 1 })).toEqual({ ok: true, value: { key: 'DETAIL_CEPH_H01', base: 'Old text', text: 'New text', note: 'n' } })
  })
  it('normalizes newlines and trims', () => {
    expect(run(payload({ base: '', text: '  a\r\nb  ' }))).toEqual({ ok: true, value: { key: 'DETAIL_CEPH_H01', base: '', text: 'a\nb' } })
  })
  it('rejects non-objects', () => {
    for (const bad of [null, undefined, 'x', [], 3]) expect(errs(run(bad))).toEqual(['payload:payload_invalid'])
  })
  it('key: letters, digits and underscores only', () => {
    for (const bad of ['', 'A-B', 'a b', 7, null, undefined, 'K'.repeat(101)]) expect(errs(run(payload({ key: bad })))).toEqual(['payload.key:key_invalid'])
    expect(run(payload({ key: 'bio_s01' })).ok).toBe(true)
  })
  it('text: required, at most 2000 characters, plain', () => {
    expect(errs(run(payload({ text: '   ' })))).toEqual(['payload.text:text_required'])
    expect(errs(run(payload({ text: undefined })))).toEqual(['payload.text:text_required'])
    expect(errs(run(payload({ text: 'x'.repeat(2001) })))).toEqual(['payload.text:text_too_long'])
    expect(run(payload({ text: 'x'.repeat(2000) })).ok).toBe(true)
    for (const t of ['a<b', 'a>b', '{%', '{{', '{#', 'a\tb', 'a\u0007']) expect(errs(run(payload({ text: t })))).toEqual(['payload.text:text_invalid'])
    expect(run(payload({ text: 'Paragraph one.\n\nParagraph two.' })).ok).toBe(true)
  })
  it('base: a string up to 2000 characters, may be empty', () => {
    expect(run(payload({ base: '' })).ok).toBe(true)
    for (const b of [undefined, 1, 'x'.repeat(2001)]) expect(errs(run(payload({ base: b })))).toEqual(['payload.base:base_invalid'])
  })
  it('text must differ from base', () => {
    expect(errs(run(payload({ base: 'Same', text: 'Same\n' })))).toEqual(['payload.text:text_same_as_base'])
  })
  it('note: optional, at most 500 characters, plain', () => {
    expect(errs(run(payload({ note: 'x'.repeat(501) })))).toEqual(['payload.note:note_too_long'])
    expect(errs(run(payload({ note: '{{x}}' })))).toEqual(['payload.note:note_invalid'])
    expect(run(payload({ note: '' })).ok).toBe(true)
  })
})

describe('lah-bio-tl roster (soft check)', () => {
  it('accepts a translatable bio', () => {
    expect(run(payload(), roster).ok).toBe(true)
  })
  it('rejects a bio that is not in the roster (including inherited properties)', () => {
    expect(errs(run(payload({ key: 'DETAIL_OTHER_H01' }), roster))).toEqual(['payload.key:bio_not_translatable'])
    expect(errs(run(payload({ key: 'constructor' }), roster))).toEqual(['payload.key:bio_not_translatable'])
  })
  it('is not enforced without a roster or with a malformed one', () => {
    expect(run(payload({ key: 'DETAIL_OTHER_H01' })).ok).toBe(true)
    for (const bad of [null, 'x', 1, [], {}, { bios: null }, { bios: [] }, { resources: {} }]) expect(run(payload({ key: 'DETAIL_OTHER_H01' }), bad).ok).toBe(true)
  })
})

describe('lah-bio-tl def', () => {
  it('is account-only, not editable, not public and offers English and both Chinese scripts', () => {
    expect(lahBioTl).toMatchObject({ id: 'lah-bio-tl', accountOnly: true, editable: false, publicList: false, tags: [], rosterPath: '/api/bio-roster.json' })
    expect(lahBioTl.langs.map((l) => l.value)).toEqual(['en', 'zh-Hans', 'zh-Hant'])
    expect(lahBioTl.title).toBeUndefined()
    expect(lahBioTl.explanation).toBeUndefined()
    expect(lahBioTl.demoUrl).toBeUndefined()
  })
  it('fits the longest allowed bio', () => {
    expect(JSON.stringify({ key: 'K'.repeat(100), base: 'b'.repeat(2000), text: 't'.repeat(2000), note: 'n'.repeat(500) }).length).toBeLessThan(lahBioTl.maxPayloadBytes)
  })
  it('moderationText is the text', () => {
    expect(lahBioTl.moderationText!({ key: 'k', base: '', text: 'hello' })).toBe('hello')
  })
})

describe('lah-bio-tl per-language roster check', () => {
  const open = { bios: { DETAIL_CEPH_H01: { jp: 'x', langs: ['en', 'hans', 'hant'] }, bio_s01: { jp: 'y', langs: ['en'] }, bio_nojp: { jp: '', langs: ['en', 'hans'] } } }

  it('accepts a zh suggestion for a bio that is open in that language', () => {
    expect(run(payload({ text: '一段简介' }), open, 'zh-Hans').ok).toBe(true)
    expect(run(payload({ text: '一段簡介' }), open, 'zh-Hant').ok).toBe(true)
  })
  it('rejects a bio the game already translated into that language', () => {
    expect(errs(run(payload({ key: 'bio_s01', text: '简介' }), open, 'zh-Hans'))).toEqual(['payload.key:bio_not_translatable'])
    expect(run(payload({ key: 'bio_s01' }), open, 'en').ok).toBe(true)
  })
  it('needs Japanese text to translate from', () => {
    expect(errs(run(payload({ key: 'bio_nojp', text: '简介' }), open, 'zh-Hans'))).toEqual(['payload.key:jp_required'])
    expect(run(payload({ key: 'bio_nojp' }), open, 'en').ok).toBe(true)
  })
  it('an entry without langs offers every language', () => {
    expect(run(payload({ text: '简介' }), roster, 'zh-Hant').ok).toBe(true)
  })
})
