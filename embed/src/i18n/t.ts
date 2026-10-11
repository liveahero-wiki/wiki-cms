import type { Lang } from '../../../src/shared/i18n.ts'
import { en, type Bundle, type Key } from './en.ts'
import { ja } from './ja.ts'
import { zhHans } from './zh-Hans.ts'
import { zhHant } from './zh-Hant.ts'

export type { Key }
const bundles: Record<Lang, Partial<Bundle>> = { en, 'zh-Hans': zhHans, 'zh-Hant': zhHant, ja }

export function hasKey(key: string): key is Key {
  return key in en
}

/** Translate `key` into `lang` (English fallback), replacing `{name}` placeholders from `params`. */
export function t(lang: Lang, key: Key, params?: Record<string, string | number>): string {
  const s = bundles[lang][key] ?? en[key]
  return params ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : s
}

/** Localize a field error from its `code`/`params`; unknown codes fall back to the server's English `message`. */
export function fieldErrorText(lang: Lang, e: { code: string; message: string; params?: Record<string, string | number> }): string {
  const key = `err.${e.code}`
  return hasKey(key) ? t(lang, key, e.params) : e.message
}

/** Localize a top-level API error code (`error.code`), falling back to its English message. */
export function apiErrorText(lang: Lang, code: string, message?: string): string {
  const key = `api.${code}`
  if (hasKey(key)) return t(lang, key)
  return message || t(lang, 'api.unknown')
}
