import { createContext, type ComponentChildren } from 'preact'
import { useContext, useEffect, useState } from 'preact/hooks'
import type { AdminGroup, GroupsResponse, MeResponse, TypeConfig } from '../../src/shared/api-types.ts'
import type { SubmissionPlugin } from '../../src/shared/plugin-api.ts'
import { api, errorMessage, raw } from './api.ts'
import { useAsync } from './hooks.ts'
import { loadPlugin } from './plugin.ts'
import { refreshCounts } from './session.ts'

export type PluginState =
  | { status: 'loading' }
  | { status: 'ready'; plugin: SubmissionPlugin }
  | { status: 'failed'; error: string }

export interface TypeData {
  typeId: string
  info: MeResponse['types'][number]
  /** Public type config (tag labels, langs, explanation limits). */
  config: TypeConfig | undefined
  configError: string | null
  /** All registry groups plus groups that only exist through submissions (`?all=1`). */
  groups: AdminGroup[] | undefined
  groupsError: string | null
  /** Reloads the per-state counts and, with them, the sidebar's pending badges. */
  reloadGroups: () => void
  plugin: PluginState
}

const configs = new Map<string, Promise<TypeConfig>>()
const loadConfig = (typeId: string) => {
  let p = configs.get(typeId)
  if (!p) {
    p = raw.get<TypeConfig>(`/api/v1/types/${encodeURIComponent(typeId)}`)
    p.catch(() => configs.delete(typeId))
    configs.set(typeId, p)
  }
  return p
}

const Ctx = createContext<TypeData | null>(null)
export const useTypeData = () => {
  const v = useContext(Ctx)
  if (!v) throw new Error('useTypeData outside <TypeProvider>')
  return v
}

export function TypeProvider({ info, children }: { info: MeResponse['types'][number]; children: ComponentChildren }) {
  const typeId = info.id
  const config = useAsync(() => loadConfig(typeId), [typeId])
  const groups = useAsync(() => api.get<GroupsResponse>(`/types/${encodeURIComponent(typeId)}/groups?all=1`), [typeId])
  const [plugin, setPlugin] = useState<PluginState>({ status: 'loading' })
  useEffect(() => {
    let live = true
    setPlugin({ status: 'loading' })
    loadPlugin(typeId, info.pluginUrl).then(
      (p) => live && setPlugin({ status: 'ready', plugin: p }),
      (e) => live && setPlugin({ status: 'failed', error: errorMessage(e) }),
    )
    return () => {
      live = false
    }
  }, [typeId, info.pluginUrl])

  const value: TypeData = {
    typeId,
    info,
    config: config.data,
    configError: config.error ? errorMessage(config.error) : null,
    groups: groups.data?.groups,
    groupsError: groups.error ? errorMessage(groups.error) : null,
    reloadGroups: () => {
      groups.reload()
      void refreshCounts()
    },
    plugin,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** English label for a tag option/definition. */
export function tagLabels(config: TypeConfig | undefined, tags: Record<string, string>): { key: string; label: string; value: string }[] {
  return Object.entries(tags).map(([key, value]) => {
    const def = config?.tags.find((t) => t.key === key)
    const opt = def?.options.find((o) => o.value === value)
    return { key, label: def ? def.label.en : key, value: opt ? opt.label.en : value }
  })
}

export const langLabel = (config: TypeConfig | undefined, lang: string) => config?.langs.find((l) => l.value === lang)?.label ?? lang

export const groupOf = (td: TypeData, groupId: string): AdminGroup | undefined => td.groups?.find((g) => g.groupId === groupId)

/**
 * Whether the type really is split into groups. Every LAH type now lives in the single group `all`,
 * so the group filter, the group chips and the edit dialog's group picker stay hidden until a type
 * has more than one; nothing about the data model changes.
 */
export const isGrouped = (td: TypeData): boolean => (td.groups?.length ?? 0) > 1

export const groupTitle = (td: TypeData, groupId: string): string => groupOf(td, groupId)?.title ?? groupId
