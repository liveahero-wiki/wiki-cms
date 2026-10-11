import { cache } from 'cloudflare:workers'

export type Purger = (opts: CachePurgeOptions) => Promise<CachePurgeResult>

/** Workers Cache purge (scoped to this Worker; works from fetch and scheduled handlers). */
export const defaultPurger: Purger = (opts) => cache.purge(opts)
