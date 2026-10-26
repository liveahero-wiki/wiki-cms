// Option validation for the public `window.cmsEmbed.openForm()`. Pure: no DOM access beyond `instanceof HTMLElement`,
// so the loader can import it without pulling in Preact or the form chunk.
import type { ContribContent } from '../../src/shared/api-types.ts'
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
  /** Edit one of the signed-in contributor's own submissions instead of creating a new one (the form is prefilled from `initial`). */
  edit?: EditTarget
  /**
   * A new submission whose team the host has already built (its own editor): the form shows it read-only and submits it
   * unchanged, and the unsent draft covers only the other fields. Not combinable with `edit`.
   */
  payload?: Record<string, unknown>
  /** Called once when the dialog has been closed and removed from `host` (submitted or not), e.g. to refresh the host's own list. */
  onClose?: () => void
}

/** An item of `cmsEmbed.contrib.mine()`: send its `id`, `version` and the content to start from (the pending edit's content if there is one). */
export interface EditTarget {
  id: string
  version: number
  initial: ContribContent
}

export interface NormalizedFormOptions {
  host: HTMLElement
  opts: ListOpts
  uiLang: Lang
  groupOptions: Record<string, unknown>
  edit?: EditTarget
  payload?: Record<string, unknown>
  onClose?: () => void
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

export function normalizeFormOptions(o: unknown, defaultApi: string, resolveLang: (host: HTMLElement) => Lang): NormalizedFormOptions | Error {
  if (!isPlainObject(o)) return new Error('openForm: options must be an object')
  const { host, type, group, plugin, groupOptions, api, lang, edit, payload, onClose } = o
  if (typeof HTMLElement === 'undefined' || !(host instanceof HTMLElement)) return new Error('openForm: `host` must be an HTMLElement')
  if (!isNonEmpty(type)) return new Error('openForm: `type` is required')
  if (!isNonEmpty(group)) return new Error('openForm: `group` is required')
  if (!isNonEmpty(plugin)) return new Error('openForm: `plugin` is required')
  if (!isPlainObject(groupOptions)) return new Error('openForm: `groupOptions` must be a plain object')
  if (api !== undefined && !isNonEmpty(api)) return new Error('openForm: `api` must be a non-empty string')
  if (lang !== undefined && typeof lang !== 'string') return new Error('openForm: `lang` must be a string')

  if (edit !== undefined && !isEditTarget(edit)) return new Error('openForm: `edit` must be { id, version, initial }')
  if (payload !== undefined && !isPlainObject(payload)) return new Error('openForm: `payload` must be a plain object')
  if (payload !== undefined && edit !== undefined) return new Error('openForm: `payload` and `edit` cannot be combined')
  if (onClose !== undefined && typeof onClose !== 'function') return new Error('openForm: `onClose` must be a function')

  const uiLang = (lang !== undefined && (isLang(lang) ? lang : langFromTag(lang))) || resolveLang(host)
  return {
    host,
    opts: { api: (api ?? defaultApi).replace(/\/+$/, ''), type, group, plugin },
    uiLang,
    groupOptions,
    ...(edit ? { edit } : {}),
    ...(payload ? { payload } : {}),
    ...(onClose ? { onClose: onClose as () => void } : {}),
  }
}

function isEditTarget(v: unknown): v is EditTarget {
  if (!isPlainObject(v) || !isNonEmpty(v.id) || typeof v.version !== 'number' || !Number.isInteger(v.version)) return false
  const i = v.initial
  return isPlainObject(i) && typeof i.title === 'string' && isPlainObject(i.tags) && typeof i.lang === 'string' && typeof i.explanation === 'string' && typeof i.demoUrl === 'string' && 'payload' in i
}
