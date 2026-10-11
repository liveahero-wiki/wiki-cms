import { and, desc, eq } from 'drizzle-orm'
import { KV_PUBLISH_TTL_SECONDS, PUBLISH_REV } from '../config.ts'
import type { Env } from '../env.ts'
import type { Purger } from './cache.ts'
import { getDb } from './db/client.ts'
import { submission_tab } from './db/schema.ts'
import { getGroup } from './groups.ts'
import type { ResolvedType } from './types-runtime.ts'

export interface PublicItem {
  id: string
  createdAt: number
  lang: string
  tags: Record<string, string>
  demoUrl: string
  explanationHtml: string
  payload: unknown
}

export interface PublicBlob {
  v: 1
  type: string
  group: string
  generatedAt: number
  groupOptions: Record<string, unknown>
  meta: { langs: { value: string; label: string }[]; tags: unknown[] }
  items: PublicItem[]
}

export const blobKey = (type: string, group: string) => `pub:${PUBLISH_REV}:${type}:${group}`
export const pubTag = (type: string, group: string) => `pub:${type}:${group}`
export const cfgTag = (type: string) => `cfg:${type}`

export function emptyBlob(typeId: string, rt: ResolvedType, groupId: string, options: Record<string, unknown> = {}): PublicBlob {
  return {
    v: 1,
    type: typeId,
    group: groupId,
    generatedAt: Date.now(),
    groupOptions: options,
    meta: { langs: rt.def.langs, tags: rt.def.tags },
    items: [],
  }
}

/** Build the public blob from D1 (approved rows only, newest first). Never includes private columns. */
export async function buildBlob(env: Env, typeId: string, rt: ResolvedType, groupId: string, options: Record<string, unknown>): Promise<PublicBlob> {
  const rows = await getDb(env)
    .select({
      id: submission_tab.id,
      createdAt: submission_tab.createdAt,
      lang: submission_tab.lang,
      tags: submission_tab.tags,
      demoUrl: submission_tab.demoUrl,
      explanationHtml: submission_tab.explanationHtml,
      payload: submission_tab.payload,
    })
    .from(submission_tab)
    .where(and(eq(submission_tab.type, typeId), eq(submission_tab.groupId, groupId), eq(submission_tab.state, 'approved')))
    .orderBy(desc(submission_tab.createdAt), desc(submission_tab.id))
    .all()
  const blob = emptyBlob(typeId, rt, groupId, options)
  blob.items = rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    lang: r.lang,
    tags: JSON.parse(r.tags),
    demoUrl: r.demoUrl,
    explanationHtml: r.explanationHtml,
    payload: JSON.parse(r.payload),
  }))
  return blob
}

export interface RepublishResult {
  purge: { success: boolean; errors: unknown[] }
}

/**
 * Rebuild the KV blob for (type, group), then purge the Workers Cache copy.
 * KV first, purge second. A failed purge never throws: it is reported in the result.
 */
export async function republish(env: Env, typeId: string, rt: ResolvedType, groupId: string, purge: Purger): Promise<RepublishResult> {
  const group = await getGroup(env, typeId, rt, groupId)
  if (group) {
    const blob = await buildBlob(env, typeId, rt, groupId, group.options)
    await env.KV.put(blobKey(typeId, groupId), JSON.stringify(blob), { expirationTtl: KV_PUBLISH_TTL_SECONDS })
  } else {
    await env.KV.delete(blobKey(typeId, groupId))
  }
  try {
    const res = await purge({ tags: [pubTag(typeId, groupId)] })
    return { purge: { success: res.success, errors: res.errors ?? [] } }
  } catch (e) {
    return { purge: { success: false, errors: [String(e)] } }
  }
}

/** Republish several groups (deduplicated); returns whether every purge succeeded. */
export async function republishMany(env: Env, typeId: string, rt: ResolvedType, groupIds: Iterable<string>, purge: Purger): Promise<{ purgeOk: boolean; errors: unknown[] }> {
  let purgeOk = true
  const errors: unknown[] = []
  for (const g of new Set(groupIds)) {
    const r = await republish(env, typeId, rt, g, purge)
    if (!r.purge.success) {
      purgeOk = false
      errors.push(...r.purge.errors)
    }
  }
  return { purgeOk, errors }
}
