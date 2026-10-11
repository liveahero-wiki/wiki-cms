export type Lang = 'en' | 'zh-Hans' | 'zh-Hant' | 'ja'
export const LANGS: readonly Lang[] = ['en', 'zh-Hans', 'zh-Hant', 'ja']
export type I18nText = { en: string } & Partial<Record<Lang, string>>

export function isLang(v: unknown): v is Lang {
  return typeof v === 'string' && (LANGS as readonly string[]).includes(v)
}

/** Pick the text for `lang`, falling back to English. */
export function pickText(text: I18nText, lang: Lang): string {
  return text[lang] ?? text.en
}

/** Map a BCP-47-ish tag (navigator.language, <html lang>) to a supported Lang, or null. */
export function langFromTag(tag: string | null | undefined): Lang | null {
  if (!tag) return null
  const t = tag.trim().toLowerCase()
  if (!t) return null
  if (t === 'ja' || t.startsWith('ja-')) return 'ja'
  if (t === 'en' || t.startsWith('en-')) return 'en'
  if (t.startsWith('zh')) {
    if (/hant|-tw|-hk|-mo/.test(t)) return 'zh-Hant'
    return 'zh-Hans'
  }
  return null
}

/**
 * UI language resolution (first match wins): `data-cms-lang` on the host element →
 * <html lang> → navigator.language → en. Browser-only (reads `document`/`navigator`).
 */
export function resolveUiLang(host?: Element | null): Lang {
  const explicit = host?.getAttribute('data-cms-lang')
  const fromAttr = explicit && isLang(explicit) ? explicit : langFromTag(explicit)
  if (fromAttr) return fromAttr
  const fromHtml = langFromTag(typeof document !== 'undefined' ? document.documentElement.lang : null)
  if (fromHtml) return fromHtml
  const fromNav = langFromTag(typeof navigator !== 'undefined' ? navigator.language : null)
  return fromNav ?? 'en'
}
