// Option validation for the public `window.cmsEmbed.openForm()`. Pure: no DOM access beyond `instanceof HTMLElement`,
// so the loader can import it without pulling in Preact or the form chunk.
import { isLang, langFromTag, type Lang } from '../../src/shared/i18n.ts'
import type { ListOpts } from './shared.ts'

export interface OpenFormOptions {
  /** The dialog is appended inside it; it gets the class `cms-submissions` (theme variables inherit). */
  host: HTMLElement
  type: string
  group: string
  /** Plugin module URL, resolved against document.baseURI (same as data-cms-plugin). */
  plugin: string
  /** `groupOptions` of the list blob; passed to the plugin as ctx.group.options. */
  groupOptions: Record<string, unknown>
  /** Worker origin. Defaults to the origin v1.js was served from. */
  api?: string
  /** UI language: a Lang or a BCP-47 tag. Default: resolveUiLang(host). */
  lang?: string
}

export interface NormalizedFormOptions {
  host: HTMLElement
  opts: ListOpts
  uiLang: Lang
  groupOptions: Record<string, unknown>
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

export function normalizeFormOptions(o: unknown, defaultApi: string, resolveLang: (host: HTMLElement) => Lang): NormalizedFormOptions | Error {
  if (!isPlainObject(o)) return new Error('openForm: options must be an object')
  const { host, type, group, plugin, groupOptions, api, lang } = o
  if (typeof HTMLElement === 'undefined' || !(host instanceof HTMLElement)) return new Error('openForm: `host` must be an HTMLElement')
  if (!isNonEmpty(type)) return new Error('openForm: `type` is required')
  if (!isNonEmpty(group)) return new Error('openForm: `group` is required')
  if (!isNonEmpty(plugin)) return new Error('openForm: `plugin` is required')
  if (!isPlainObject(groupOptions)) return new Error('openForm: `groupOptions` must be a plain object')
  if (api !== undefined && !isNonEmpty(api)) return new Error('openForm: `api` must be a non-empty string')
  if (lang !== undefined && typeof lang !== 'string') return new Error('openForm: `lang` must be a string')

  const uiLang = (lang !== undefined && (isLang(lang) ? lang : langFromTag(lang))) || resolveLang(host)
  return {
    host,
    opts: { api: (api ?? defaultApi).replace(/\/+$/, ''), type, group, plugin },
    uiLang,
    groupOptions,
  }
}
