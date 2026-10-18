import { describe, expect, it } from 'vitest'
import { LANGS } from '../../../src/shared/i18n.ts'
import { en } from './en.ts'
import { ja } from './ja.ts'
import { loaderStrings } from './loader.ts'
import { apiErrorText, fieldErrorText, t } from './t.ts'
import { zhHans } from './zh-Hans.ts'
import { zhHant } from './zh-Hant.ts'

const others = { 'zh-Hans': zhHans, 'zh-Hant': zhHant, ja } as const
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('embed i18n bundles', () => {
  for (const [lang, bundle] of Object.entries(others)) {
    it(`${lang} defines every en key (non-empty, same placeholders, no extras)`, () => {
      const b = bundle as Record<string, string>
      for (const [key, text] of Object.entries(en)) {
        expect(typeof b[key], `${lang} missing ${key}`).toBe('string')
        expect(b[key]!.trim(), `${lang} empty ${key}`).not.toBe('')
        expect(placeholders(b[key]!), `${lang} placeholders of ${key}`).toEqual(placeholders(text))
      }
      expect(Object.keys(b).filter((k) => !(k in en))).toEqual([])
    })
  }

  it('covers every generic field error code and top-level API code', () => {
    const fieldCodes = [
      'lang_invalid', 'tag_required', 'tag_invalid', 'explanation_required', 'explanation_too_long', 'md_html', 'md_link', 'md_link_invalid', 'md_link_text', 'md_link_limit',
      'demo_required', 'demo_too_long', 'demo_invalid', 'demo_https', 'demo_host', 'payload_invalid', 'payload_too_large',
      'title_required', 'title_too_short', 'title_too_long', 'title_link', 'title_invalid',
    ]
    for (const c of fieldCodes) expect(en, `err.${c}`).toHaveProperty(`err.${c}`)
    const apiCodes = ['validation_failed', 'turnstile_failed', 'rate_limited', 'daily_cap', 'ip_blocked', 'pending_cap', 'bad_origin', 'unknown_group', 'unknown_type', 'too_large', 'bad_json', 'network', 'unknown', 'account_required', 'unauthenticated', 'forbidden', 'not_found', 'not_editable', 'no_changes', 'version_conflict']
    for (const c of apiCodes) expect(en, `api.${c}`).toHaveProperty(`api.${c}`)
  })

  it('loader strings exist for every language', () => {
    for (const lang of LANGS) {
      for (const v of Object.values(loaderStrings[lang])) expect(v.trim()).not.toBe('')
    }
  })

  it('t() interpolates and falls back', () => {
    expect(t('en', 'err.explanation_too_long', { max: 5000 })).toContain('5000')
    expect(t('ja', 'err.explanation_too_long', { max: 5000 })).toContain('5000')
    expect(fieldErrorText('ja', { code: 'no_such_code', message: 'English fallback' })).toBe('English fallback')
    expect(fieldErrorText('zh-Hant', { code: 'demo_host', message: 'x' })).toBe(zhHant['err.demo_host'])
    expect(apiErrorText('en', 'rate_limited')).toBe(en['api.rate_limited'])
    expect(apiErrorText('en', 'weird', 'Server text')).toBe('Server text')
    expect(apiErrorText('en', 'weird')).toBe(en['api.unknown'])
  })
})
