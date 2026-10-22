import type { FieldError } from '../shared/plugin-api.ts'

const MAX_LEN = 300

export type DemoPlatform = 'youtube' | 'twitter' | 'bluesky' | 'bilibili'

/** Bilibili share/tracking params; `p` (part) and `t` (timestamp) are kept. */
const BILIBILI_TRACKING = new Set([
  'spm_id_from', 'vd_source', 'share_source', 'share_medium', 'share_plat', 'share_session_id', 'share_tag',
  'timestamp', 'bbid', 'ts', 'from_spmid', 'unique_k', 'buvid', 'is_story_h5', 'mid', 'plat_id', 'up_id', 'from',
])

export function demoPlatform(host: string): DemoPlatform | null {
  const h = host.toLowerCase()
  if (h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'youtu.be') return 'youtube'
  if (h === 'twitter.com' || h.endsWith('.twitter.com') || h === 'x.com' || h.endsWith('.x.com')) return 'twitter'
  if (h === 'bsky.app') return 'bluesky'
  if (h === 'bilibili.com' || h.endsWith('.bilibili.com') || h === 'b23.tv') return 'bilibili'
  return null
}

/** Validate + normalize a demo link. Strips tracking params; keeps YouTube/Bilibili `t`. */
export function normalizeDemoUrl(
  input: unknown,
  opts: { required: boolean; allowedHosts: string[] },
  path = 'demoUrl',
): { ok: true; value: string } | { ok: false; error: FieldError } {
  const fail = (code: string, message: string): { ok: false; error: FieldError } => ({
    ok: false,
    error: { path, code, message },
  })
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) return opts.required ? fail('demo_required', 'A demo link is required.') : { ok: true, value: '' }
  if (raw.length > MAX_LEN) return fail('demo_too_long', `The demo link must be at most ${MAX_LEN} characters.`)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return fail('demo_invalid', 'The demo link is not a valid URL.')
  }
  if (url.protocol !== 'https:') return fail('demo_https', 'The demo link must use https.')
  if (url.username || url.password) return fail('demo_invalid', 'The demo link must not contain credentials.')
  if (url.port) return fail('demo_invalid', 'The demo link must not specify a port.')
  const host = url.hostname.toLowerCase()
  if (!opts.allowedHosts.includes(host)) {
    return fail('demo_host', 'The demo link must be a YouTube, Bilibili, X (Twitter) or Bluesky link.')
  }
  const platform = demoPlatform(host)
  for (const key of [...url.searchParams.keys()]) {
    const k = key.toLowerCase()
    if (k === 'si' || k === 'feature' || k.startsWith('utm_') || (k === 's' && platform === 'twitter') || (k === 't' && platform === 'twitter') || (platform === 'bilibili' && BILIBILI_TRACKING.has(k))) {
      url.searchParams.delete(key)
    }
  }
  url.hash = ''
  return { ok: true, value: url.toString() }
}
