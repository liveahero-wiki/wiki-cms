import { describe, expect, it } from 'vitest'
import { lahVoiceTl } from './index.ts'
import { validateVoicePayload, type VoicePayload } from './validate.ts'

const line = (part: string, over: Record<string, unknown> = {}) => ({ key: `voice_ryekie_${part}`, base: "Let's go!", text: 'Here we go!', ...over })
const payload = (over: Record<string, unknown> = {}) => ({ resourceName: 'ryekie', lines: [line('action')], ...over })
const roster = { version: '1', resources: { ryekie: { voice_ryekie_action: { jp: 'x' }, voice_ryekie_win: { jp: 'y' } } } }

const run = (input: unknown, r?: unknown, lang?: string) => validateVoicePayload(input, undefined, { roster: r, lang })
const errs = (r: ReturnType<typeof run>) => (r.ok ? [] : r.errors.map((e) => `${e.path}:${e.code}`))

describe('lah-voice-tl payload', () => {
  it('accepts a valid payload and keeps only known fields', () => {
    const r = run({ ...payload({ note: 'thanks' }), junk: 1 })
    expect(r).toEqual({ ok: true, value: { resourceName: 'ryekie', lines: [{ key: 'voice_ryekie_action', base: "Let's go!", text: 'Here we go!' }], note: 'thanks' } })
  })

  it('normalizes newlines and trims text and note; blank note is dropped; base is kept as sent', () => {
    const r = run(payload({ lines: [line('action', { base: '', text: '  a\r\nb\rc  ' })], note: '   ' }))
    expect(r).toEqual({ ok: true, value: { resourceName: 'ryekie', lines: [{ key: 'voice_ryekie_action', base: '', text: 'a\nb\nc' }] } })
  })

  it('rejects non-objects', () => {
    for (const bad of [null, undefined, 'x', 1, [], [payload()]]) expect(errs(run(bad))).toEqual(['payload:payload_invalid'])
  })

  it('checks the resource name', () => {
    for (const bad of ['', 'a-b', 'a b', 'ry/ekie', 5, null, 'x'.repeat(101)]) {
      expect(errs(run(payload({ resourceName: bad })))).toContain('payload.resourceName:resource_invalid')
    }
    expect(run(payload({ resourceName: 'Ry_ekie2', lines: [line('x', { key: 'voice_Ry_ekie2_x' })] })).ok).toBe(true)
  })

  it('needs 1..100 lines', () => {
    expect(errs(run(payload({ lines: [] })))).toEqual(['payload.lines:lines_length'])
    expect(errs(run(payload({ lines: 'x' })))).toEqual(['payload.lines:lines_length'])
    const many = (n: number) => Array.from({ length: n }, (_, i) => line(`p${i}`))
    expect(run(payload({ lines: many(100) })).ok).toBe(true)
    expect(errs(run(payload({ lines: many(101) })))).toEqual(['payload.lines:lines_length'])
  })

  it('keys must be voice_<resourceName>_<part> of the same resource and unique', () => {
    const bad = [{ key: 'voice_other_action' }, { key: 'voice_ryekie_' }, { key: 'ryekie_action' }, { key: 'voice_ryekie_a-b' }, { key: 5 }, { key: undefined }, { key: 'voice_ryekiex_a' }]
    for (const b of bad) expect(errs(run(payload({ lines: [line('a', b)] })))).toEqual(['payload.lines.0.key:key_invalid'])
    const dup = run(payload({ lines: [line('a'), line('b'), line('a', { text: 'Other' })] }))
    expect(errs(dup)).toEqual(['payload.lines.2.key:key_duplicate'])
  })

  it('malformed lines get a path', () => {
    expect(errs(run(payload({ lines: ['x'] })))).toEqual(['payload.lines.0:payload_invalid'])
  })

  it('text: required, at most 2000 characters, plain', () => {
    expect(errs(run(payload({ lines: [line('a'), line('b', { text: '  \n ' })] })))).toEqual(['payload.lines.1.text:text_required'])
    expect(errs(run(payload({ lines: [line('a', { text: 5 })] })))).toEqual(['payload.lines.0.text:text_required'])
    expect(run(payload({ lines: [line('a', { text: 'x'.repeat(2000) })] })).ok).toBe(true)
    expect(errs(run(payload({ lines: [line('a', { text: 'x'.repeat(2001) })] })))).toEqual(['payload.lines.0.text:text_too_long'])
    for (const t of ['<b>hi</b>', 'a > b', '{% if %}', '{{ x }}', '{# c #}', 'tab\there', 'nul\u0000', 'esc\u001b[0m', 'del\u007f']) {
      expect(errs(run(payload({ lines: [line('a', { text: t })] })))).toEqual(['payload.lines.0.text:text_invalid'])
    }
    expect(run(payload({ lines: [line('a', { text: 'Line one\nLine two { braces } 100% "quotes" 日本語' })] })).ok).toBe(true)
  })

  it('base: a string up to 2000 characters, may be empty', () => {
    expect(run(payload({ lines: [line('a', { base: '' })] })).ok).toBe(true)
    expect(run(payload({ lines: [line('a', { base: 'h<br>i {{x}}' })] })).ok).toBe(true) // data from the sheet, not user text
    for (const b of [undefined, 5, null, 'x'.repeat(2001)]) expect(errs(run(payload({ lines: [line('a', { base: b })] })))).toEqual(['payload.lines.0.base:base_invalid'])
  })

  it('text must differ from base (ignoring surrounding space and CRLF)', () => {
    expect(errs(run(payload({ lines: [line('a', { base: 'Same', text: ' Same ' })] })))).toEqual(['payload.lines.0.text:text_same_as_base'])
    expect(errs(run(payload({ lines: [line('a', { base: 'A\r\nB', text: 'A\nB' })] })))).toEqual(['payload.lines.0.text:text_same_as_base'])
    expect(run(payload({ lines: [line('a', { base: 'Same', text: 'same' })] })).ok).toBe(true)
  })

  describe('jp transcription', () => {
    const noJp = { version: '1', resources: { ryekie: { voice_ryekie_action: { jp: '' }, voice_ryekie_win: { jp: 'y' } } } }

    it('is kept (trimmed, newlines normalized) next to the translation', () => {
      const r = run(payload({ lines: [line('action', { base: '', text: 'Go', jp: '  行く\r\nぞ ' })] }), noJp)
      expect(r).toEqual({ ok: true, value: { resourceName: 'ryekie', lines: [{ key: 'voice_ryekie_action', base: '', text: 'Go', jp: '行く\nぞ' }] } })
    })

    it('makes the translation optional; without a jp it stays required', () => {
      const r = run(payload({ lines: [line('action', { base: '', text: '', jp: '行くぞ' })] }), noJp)
      expect(r).toEqual({ ok: true, value: { resourceName: 'ryekie', lines: [{ key: 'voice_ryekie_action', base: '', text: '', jp: '行くぞ' }] } })
      expect(run(payload({ lines: [line('action', { text: undefined, jp: '行くぞ' })] }), noJp).ok).toBe(true)
      expect(errs(run(payload({ lines: [line('action', { text: ' ', jp: '  ' })] }), noJp))).toEqual(['payload.lines.0.text:text_required'])
    })

    it('a blank jp counts as absent and is dropped', () => {
      const r = run(payload({ lines: [line('action', { jp: ' ' })] }), noJp)
      expect(r.ok && r.value.lines[0]).toEqual({ key: 'voice_ryekie_action', base: "Let's go!", text: 'Here we go!' })
    })

    it('is plain text of at most 2000 characters', () => {
      for (const t of ['<b>', '{{ x }}', 'nul\u0000', 5]) {
        expect(errs(run(payload({ lines: [line('action', { jp: t })] }), noJp))).toEqual(['payload.lines.0.jp:text_invalid'])
      }
      expect(errs(run(payload({ lines: [line('action', { jp: 'あ'.repeat(2001) })] }), noJp))).toEqual(['payload.lines.0.jp:text_too_long'])
    })

    it('is refused for a line the roster already has Japanese text for', () => {
      expect(errs(run(payload({ lines: [line('win', { jp: '勝った' })] }), noJp))).toEqual(['payload.lines.0.jp:jp_not_allowed'])
      expect(run(payload({ lines: [line('win', { jp: '勝った' })] })).ok).toBe(true) // soft check: no roster, no refusal
    })

    it('is part of the moderation text', () => {
      const text = lahVoiceTl.moderationText?.({ resourceName: 'ryekie', lines: [{ key: 'voice_ryekie_action', base: '', text: 'Go', jp: '行くぞ' }] })
      expect(text).toContain('行くぞ')
    })
  })

  it('note: optional, at most 500 characters, plain', () => {
    expect(run(payload({ note: 'x'.repeat(500) })).ok).toBe(true)
    expect(errs(run(payload({ note: 'x'.repeat(501) })))).toEqual(['payload.note:note_too_long'])
    expect(errs(run(payload({ note: '<script>' })))).toEqual(['payload.note:note_invalid'])
    expect(errs(run(payload({ note: 5 })))).toEqual(['payload.note:note_invalid'])
    expect(run(payload({ note: null })).ok).toBe(true)
  })

  it('reports every error at once with a code, message and path', () => {
    const r = run(payload({ lines: [line('a', { text: '<b>' }), line('a'), { key: 'x' }], note: 'x'.repeat(501) }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThanOrEqual(4)
      for (const e of r.errors) expect(e.code && e.message && e.path).toBeTruthy()
    }
  })
})

describe('lah-voice-tl per-language roster check', () => {
  const open = { resources: { ryekie: { voice_ryekie_action: { jp: 'x', langs: ['en', 'hans', 'hant'] }, voice_ryekie_win: { jp: 'y', langs: ['en'] }, voice_ryekie_lose: { jp: '', langs: ['en', 'hans'] } } } }

  it('accepts a zh suggestion for a line that is open in that language', () => {
    expect(run(payload({ lines: [line('action', { base: '', text: '出发' })] }), open, 'zh-Hans').ok).toBe(true)
    expect(run(payload({ lines: [line('action', { base: '', text: '出發' })] }), open, 'zh-Hant').ok).toBe(true)
  })
  it('rejects a line the game already translated into that language', () => {
    expect(errs(run(payload({ lines: [line('win', { base: '', text: '赢了' })] }), open, 'zh-Hans'))).toEqual(['payload.lines.0.key:line_not_translatable'])
    expect(run(payload({ lines: [line('win')] }), open, 'en').ok).toBe(true)
  })
  it('rejects English for a line the game already has English text for', () => {
    const roster = { resources: { ryekie: { voice_ryekie_action: { jp: 'x', langs: ['hans'] } } } }
    expect(errs(run(payload(), roster, 'en'))).toEqual(['payload.lines.0.key:line_not_translatable'])
  })
  it('needs Japanese text to translate from', () => {
    expect(errs(run(payload({ lines: [line('lose', { base: '', text: '输了' })] }), open, 'zh-Hans'))).toEqual(['payload.lines.0.key:jp_required'])
  })
  it('the jp transcription belongs to English submissions only', () => {
    expect(errs(run(payload({ lines: [line('lose', { base: '', text: '输了', jp: '負けた' })] }), open, 'zh-Hans'))).toContain('payload.lines.0.jp:jp_not_allowed')
    expect(run(payload({ lines: [line('lose', { base: '', text: '', jp: '負けた' })] }), open, 'en').ok).toBe(true)
  })
  it('an entry without langs (an older roster) offers every language; without a roster nothing is checked', () => {
    expect(run(payload({ lines: [line('action', { base: '', text: '出发' })] }), roster, 'zh-Hant').ok).toBe(true)
    expect(run(payload({ lines: [line('anything', { base: '', text: '出发' })] }), undefined, 'zh-Hant').ok).toBe(true)
  })
  it('the same-as-base and plain-text rules apply to zh text too', () => {
    expect(errs(run(payload({ lines: [line('action', { base: '出发', text: '出发' })] }), open, 'zh-Hans'))).toEqual(['payload.lines.0.text:text_same_as_base'])
    expect(errs(run(payload({ lines: [line('action', { base: '', text: '出<发' })] }), open, 'zh-Hans'))).toEqual(['payload.lines.0.text:text_invalid'])
  })
})

describe('lah-voice-tl roster (soft check)', () => {
  it('accepts translatable keys of a known resource', () => {
    expect(run(payload({ lines: [line('action'), line('win')] }), roster).ok).toBe(true)
  })
  it('rejects a key that is not in the roster', () => {
    expect(errs(run(payload({ lines: [line('action'), line('lose')] }), roster))).toEqual(['payload.lines.1.key:line_not_translatable'])
  })
  it('rejects an unknown resource (and does not repeat it per line)', () => {
    const r = run({ resourceName: 'nobody', lines: [{ key: 'voice_nobody_a', base: '', text: 'x' }] }, roster)
    expect(errs(r)).toEqual(['payload.resourceName:unknown_resource'])
  })
  it('does not treat inherited object properties as roster entries', () => {
    expect(errs(run({ resourceName: 'constructor', lines: [{ key: 'voice_constructor_a', base: '', text: 'x' }] }, roster))).toEqual(['payload.resourceName:unknown_resource'])
    expect(errs(run(payload({ lines: [line('toString')] }), roster))).toEqual(['payload.lines.0.key:line_not_translatable'])
  })
  it('is not enforced without a roster or with a malformed one', () => {
    const p = payload({ lines: [line('anything')] })
    expect(run(p).ok).toBe(true)
    for (const bad of [null, 'x', 5, [], {}, { resources: null }, { resources: [] }, { resources: 'x' }, { bios: {} }]) expect(run(p, bad).ok).toBe(true)
  })
  it('a resource entry that is not an object counts as unknown when the roster is well-formed', () => {
    expect(errs(run(payload(), { resources: { ryekie: 5 } }))).toEqual(['payload.resourceName:unknown_resource'])
  })
})

describe('lah-voice-tl def', () => {
  it('is account-only, not editable, not public and offers English and both Chinese scripts', () => {
    expect(lahVoiceTl).toMatchObject({ id: 'lah-voice-tl', accountOnly: true, editable: false, publicList: false, tags: [], rosterPath: '/api/voice-roster.json' })
    expect(lahVoiceTl.langs.map((l) => l.value)).toEqual(['en', 'zh-Hans', 'zh-Hant'])
    expect(lahVoiceTl.title).toBeUndefined()
    expect(lahVoiceTl.explanation).toBeUndefined()
    expect(lahVoiceTl.demoUrl).toBeUndefined()
  })
  it('fits 100 lines of 1000 characters each way', () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({ key: `voice_ryekie_part${i}`, base: 'b'.repeat(1000), text: 't'.repeat(1000) }))
    expect(JSON.stringify({ resourceName: 'ryekie', lines }).length).toBeLessThan(lahVoiceTl.maxPayloadBytes)
    expect(lahVoiceTl.maxBodyBytes!).toBeGreaterThan(lahVoiceTl.maxPayloadBytes)
  })
  it('moderationText is short plain text of the lines', () => {
    const p: VoicePayload = { resourceName: 'r', lines: [{ key: 'a', base: '', text: 'one' }, { key: 'b', base: '', text: 'two' }] }
    expect(lahVoiceTl.moderationText!(p)).toBe('one\ntwo')
    const big: VoicePayload = { resourceName: 'r', lines: Array.from({ length: 100 }, () => ({ key: 'k', base: '', text: 'x'.repeat(1000) })) }
    expect(lahVoiceTl.moderationText!(big).length).toBe(3000)
  })
})
