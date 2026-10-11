import type { SubmissionPlugin } from '../../src/shared/plugin-api.ts'

const STORE_KEY = 'cms-admin-plugin-override'

/** `?plugin=<url>` dev override; honoured only on localhost and remembered for the tab's lifetime. */
const override: string | null = (() => {
  if (location.hostname !== 'localhost') return null
  const q = new URLSearchParams(location.search).get('plugin')
  try {
    if (q) sessionStorage.setItem(STORE_KEY, q)
    return q ?? sessionStorage.getItem(STORE_KEY)
  } catch {
    return q
  }
})()

export const pluginOverride = override

const cache = new Map<string, Promise<SubmissionPlugin>>()

/** Imports the type's plugin module once (the promise is cached, failures included). */
export function loadPlugin(typeId: string, pluginUrl: string): Promise<SubmissionPlugin> {
  const url = new URL(override ?? pluginUrl, location.href).href
  let p = cache.get(`${typeId}|${url}`)
  if (!p) {
    p = import(/* @vite-ignore */ url).then((mod: { default?: SubmissionPlugin }) => {
      const plugin = mod.default
      if (!plugin || typeof plugin !== 'object') throw new Error('The plugin module has no default export.')
      if (plugin.apiVersion !== 1) throw new Error(`Unsupported plugin apiVersion ${String(plugin.apiVersion)} (expected 1).`)
      if (plugin.type !== typeId) throw new Error(`The plugin is for type "${String(plugin.type)}", not "${typeId}".`)
      return plugin
    })
    cache.set(`${typeId}|${url}`, p)
  }
  return p
}
