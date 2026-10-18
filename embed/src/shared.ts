// Code shared by the list and form chunks (not by the loader).
import type { ApiErrorBody, PublicBlob, SubmitRequest, TypeConfig } from '../../src/shared/api-types.ts'
import { isLang, langFromTag, resolveUiLang, type Lang } from '../../src/shared/i18n.ts'
import type { FieldError, PluginContext, SubmissionPlugin } from '../../src/shared/plugin-api.ts'
import css from './styles.css?inline'

export type { Lang }
export { isLang, langFromTag, resolveUiLang }

export interface ListOpts {
  api: string
  type: string
  group: string
  /** `data-cms-plugin` as written (resolved against document.baseURI when imported). */
  plugin: string | null
}

export function injectStyle() {
  if (document.getElementById('cms-embed-style')) return
  const s = document.createElement('style')
  s.id = 'cms-embed-style'
  s.textContent = css
  document.head.appendChild(s)
}

export function currentTheme(): 'light' | 'dark' {
  const attr = document.documentElement.getAttribute('data-theme')
  if (attr === 'dark' || attr === 'light') return attr
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function makeCtx(opts: ListOpts, uiLang: Lang, groupOptions: Record<string, unknown>): PluginContext {
  return { uiLang, theme: currentTheme(), group: { id: opts.group, options: groupOptions } }
}

// ---- plugin (imported once per URL) ----

const plugins = new Map<string, Promise<SubmissionPlugin>>()

export function loadPlugin(url: string | null): Promise<SubmissionPlugin> {
  if (!url) return Promise.reject(new Error('data-cms-plugin is not set'))
  const href = new URL(url, document.baseURI).href
  let p = plugins.get(href)
  if (!p) {
    p = import(/* @vite-ignore */ href).then((m: { default?: SubmissionPlugin }) => {
      const pl = m.default
      if (!pl || pl.apiVersion !== 1 || typeof pl.mountSummary !== 'function' || typeof pl.mountEditor !== 'function') {
        throw new Error('not a wiki-cms plugin (apiVersion 1 expected)')
      }
      return pl
    })
    plugins.set(href, p)
    p.catch(() => plugins.delete(href)) // allow a later retry
  }
  return p
}

// ---- API ----

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: FieldError[],
  ) {
    super(message)
  }
}

export async function readError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as Partial<ApiErrorBody>
    return new ApiError(res.status, body.error?.code ?? 'unknown', body.error?.message ?? res.statusText, body.error?.fields)
  } catch {
    return new ApiError(res.status, 'unknown', res.statusText)
  }
}

async function getJson<T>(url: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(url) // default HTTP caching; the URL is canonical (no query string) on purpose
  } catch {
    throw new ApiError(0, 'network', 'Network error')
  }
  if (!res.ok) throw await readError(res)
  return (await res.json()) as T
}

const enc = encodeURIComponent
export const fetchBlob = (o: ListOpts) => getJson<PublicBlob>(`${o.api}/api/v1/submissions/${enc(o.type)}/${enc(o.group)}`)

const configs = new Map<string, Promise<TypeConfig>>()
export function fetchConfig(o: ListOpts): Promise<TypeConfig> {
  const key = `${o.api}|${o.type}`
  let p = configs.get(key)
  if (!p) {
    p = getJson<TypeConfig>(`${o.api}/api/v1/types/${enc(o.type)}`)
    configs.set(key, p)
    p.catch(() => configs.delete(key))
  }
  return p
}

export async function postSubmission(o: ListOpts, body: SubmitRequest): Promise<ApiError | null> {
  let res: Response
  try {
    res = await fetch(`${o.api}/api/v1/submissions/${enc(o.type)}/${enc(o.group)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    return new ApiError(0, 'network', 'Network error')
  }
  return res.ok ? null : readError(res)
}

// ---- demo link ----

export type DemoPlatform = 'YouTube' | 'X' | 'Bluesky'

/** Mirrors src/core/demo-url.ts `demoPlatform`; returns the display name. */
export function demoPlatform(host: string): DemoPlatform | null {
  const h = host.toLowerCase()
  if (h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'youtu.be') return 'YouTube'
  if (h === 'twitter.com' || h.endsWith('.twitter.com') || h === 'x.com' || h.endsWith('.x.com')) return 'X'
  if (h === 'bsky.app') return 'Bluesky'
  return null
}

export function parseHttps(url: string): URL | null {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' ? u : null
  } catch {
    return null
  }
}
