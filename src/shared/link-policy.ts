/** External links allowed in explanations (`[text](https://…)` only). Pure; shared by Worker, embed and admin. */

export const MAX_LINKS = 3
export const MAX_LINK_TEXT = 80
const MAX_URL_LEN = 200

/** Shorteners hide the real destination, so they are rejected (the host shown next to a link must be the real one). */
const BLOCKED_HOSTS = new Set([
  'bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'is.gd', 'v.gd', 'cutt.ly', 'ow.ly', 'rebrand.ly', 'lnkd.in', 's.id', 'rb.gy',
  'shorturl.at', 'tiny.cc', 't.ly', 'buff.ly', 'bl.ink', 'short.io', 'shorte.st', 'adf.ly', 'linktr.ee', 'qr.ae', 'dub.sh',
])
const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.onion']
const TRACKING_PARAMS = new Set(['si', 'feature', 'fbclid', 'gclid', 'igshid', 'mc_cid', 'mc_eid'])
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const TLD_RE = /^[a-z]{2,24}$/

/** Bare domains such as "example.com" or "foo.gg/bar" (a short list of common TLDs keeps "Lv.60" and "No.1" legal). */
export const DOMAIN_RE = /\b[a-z0-9-]{2,}\.(?:com|net|org|io|gg|jp|cn|tv|me|co|xyz|info|ly|to|app|dev|link|site|top|cc|ru)\b/i
const DOMAIN_IN_TEXT_RE = /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|gg|jp|cn|tv|me|co|xyz|info|ly|to|app|dev|link|site|top|cc|ru|so|wiki|fm|us|uk|de|kr|tw|hk|sg|moe|page|pro)\b/gi

export type LinkResult = { ok: true; href: string; host: string } | { ok: false; message: string }

const fail = (message: string): LinkResult => ({ ok: false, message })

/** Validate + normalize one link target. `host` is what readers see (hostname without a leading `www.`). */
export function normalizeExplanationLink(input: string): LinkResult {
  const raw = input.trim()
  if (!raw || raw.length > MAX_URL_LEN) return fail(`A link must be at most ${MAX_URL_LEN} characters.`)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return fail('This link is not a valid URL.')
  }
  if (url.protocol !== 'https:') return fail('Links must start with https://.')
  if (url.username || url.password) return fail('Links must not contain credentials.')
  if (url.port) return fail('Links must not specify a port.')
  const host = url.hostname.toLowerCase()
  const labels = host.split('.')
  if (
    labels.length < 2 ||
    !labels.every((l) => LABEL_RE.test(l)) ||
    !TLD_RE.test(labels[labels.length - 1]!) ||
    host.length > 100
  ) {
    return fail('This link must point to a normal website address (no IP addresses or unusual hosts).')
  }
  if (labels.some((l) => l.startsWith('xn--'))) return fail('Links to internationalized (punycode) domains are not allowed.')
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return fail('This link is not allowed.')
  const bare = host.replace(/^www\./, '')
  if ([...BLOCKED_HOSTS].some((b) => bare === b || bare.endsWith(`.${b}`))) {
    return fail('Shortened links are not allowed; use the full address.')
  }
  for (const key of [...url.searchParams.keys()]) {
    const k = key.toLowerCase()
    if (k.startsWith('utm_') || TRACKING_PARAMS.has(k)) url.searchParams.delete(key)
  }
  url.hash = ''
  return { ok: true, href: url.toString(), host: bare }
}

/** Why the visible text of a link is not acceptable, or null. Blocks `[youtube.com](https://evil.com)`. */
export function linkTextProblem(text: string, host: string): string | null {
  const t = text.trim()
  if (!t) return 'A link needs some text.'
  if ([...t].length > MAX_LINK_TEXT) return `Link text must be at most ${MAX_LINK_TEXT} characters.`
  if (/:\/\/|\bwww\./i.test(t)) return 'Link text must not look like a web address.'
  for (const m of t.match(DOMAIN_IN_TEXT_RE) ?? []) {
    const d = m.toLowerCase().replace(/^www\./, '')
    if (!(host === d || host.endsWith(`.${d}`) || d.endsWith(`.${host}`))) return 'Link text must not show a different website than the link points to.'
  }
  return null
}
