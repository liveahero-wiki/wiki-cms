import { beforeAll, describe, expect, it } from 'vitest'
import { normalizeFormOptions } from './form-api.ts'

// The unit project runs in node: stub just enough of the DOM for `instanceof HTMLElement`.
class FakeElement {}
beforeAll(() => {
  ;(globalThis as { HTMLElement?: unknown }).HTMLElement = FakeElement
})

const host = () => new FakeElement() as unknown as HTMLElement
const valid = () => ({ host: host(), type: 'lah-team-formation', group: 'all', plugin: '/p.js', groupOptions: { targets: [] } })
const fallback = () => 'en' as const

const norm = (o: unknown, resolve: (h: HTMLElement) => 'en' | 'ja' | 'zh-Hans' | 'zh-Hant' = fallback) => normalizeFormOptions(o, 'https://cms.example', resolve)

describe('normalizeFormOptions', () => {
  it('accepts valid options and defaults the api origin', () => {
    const o = valid()
    const r = norm(o)
    if (r instanceof Error) throw r
    expect(r.host).toBe(o.host)
    expect(r.opts).toEqual({ api: 'https://cms.example', type: 'lah-team-formation', group: 'all', plugin: '/p.js' })
    expect(r.groupOptions).toBe(o.groupOptions)
    expect(r.uiLang).toBe('en')
  })

  it('strips trailing slashes from api', () => {
    const r = norm({ ...valid(), api: 'http://localhost:8787//' })
    if (r instanceof Error) throw r
    expect(r.opts.api).toBe('http://localhost:8787')
  })

  it.each([
    ['non-object', null],
    ['array', []],
    ['missing host', { ...valid(), host: undefined }],
    ['host not an element', { ...valid(), host: {} }],
    ['empty type', { ...valid(), type: '' }],
    ['empty group', { ...valid(), group: ' ' }],
    ['missing plugin', { ...valid(), plugin: undefined }],
    ['groupOptions null', { ...valid(), groupOptions: null }],
    ['groupOptions array', { ...valid(), groupOptions: [] }],
    ['empty api', { ...valid(), api: '' }],
    ['non-string lang', { ...valid(), lang: 3 }],
  ])('rejects %s', (_, o) => {
    expect(norm(o)).toBeInstanceOf(Error)
  })

  it('maps lang: a Lang, a BCP-47 tag, or the fallback', () => {
    const lang = (l?: string) => {
      const r = norm({ ...valid(), lang: l }, () => 'zh-Hans')
      if (r instanceof Error) throw r
      return r.uiLang
    }
    expect(lang('ja')).toBe('ja')
    expect(lang('zh-TW')).toBe('zh-Hant')
    expect(lang('xx')).toBe('zh-Hans')
    expect(lang(undefined)).toBe('zh-Hans')
  })
})
