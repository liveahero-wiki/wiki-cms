import MarkdownIt from 'markdown-it'
import { MAX_LINKS, linkTextProblem, normalizeExplanationLink } from './link-policy.ts'
import type { FieldError } from './plugin-api.ts'

/** Markdown/URL link syntax; also used by the plain-text title check. */
export const LINK_RE = /\]\(|^\s{0,3}\[[^\]]+\]:\s*\S|!\[|<[a-z][a-z0-9+.-]*:|\b[a-z][a-z0-9+.-]*:\/\/|\bwww\./im

const HTML_RE = /<\/?[A-Za-z][^>]*>|<!--|<![A-Za-z]/
// Images and reference-style definitions are never allowed; only inline `[text](https://…)` links are.
const IMAGE_OR_REFDEF_RE = /!\[|^\s{0,3}\[[^\]]+\]:\s*\S/m
// Bare URLs, autolinks and link syntax that did not parse as a link (e.g. `[a](javascript:x)`) inside plain text or code.
const STRAY_LINK_RE = /\]\(|<[a-z][a-z0-9+.-]*:|\b[a-z][a-z0-9+.-]*:\/\/|\bwww\./i
const LINK_HELP = 'Write links as [text](https://…); bare URLs, images and HTML are not allowed.'

type Md = InstanceType<typeof MarkdownIt>
type Tok = ReturnType<Md['parse']>[number]

function createMd(): Md {
  const md = new MarkdownIt({ html: false, linkify: false, breaks: true, typographer: false })
  // Only inline links stay enabled; their rendering is replaced below so an <a> is never emitted unvalidated.
  md.disable(['image', 'autolink', 'html_block', 'html_inline', 'reference'])
  // Community headings must never compete with the wiki's h2: remap h1/h2 → h3/h4 and clamp at h6.
  md.core.ruler.push('cms_heading_levels', (state) => {
    for (const tok of state.tokens) {
      if (tok.type !== 'heading_open' && tok.type !== 'heading_close') continue
      const level = Math.min(Number(tok.tag.slice(1)) + 2, 6)
      tok.tag = `h${level}`
    }
    return true
  })
  const esc = md.utils.escapeHtml
  // An external link: re-validated here, shown with its real host inside the link, marked nofollow/ugc.
  // Invalid or surplus links degrade to their plain text.
  md.renderer.rules.link_open = (tokens, idx, _opts, env) => {
    const r = normalizeExplanationLink(String(tokens[idx]!.attrGet('href') ?? ''))
    const state = env as { links?: number } // `renderExplanation` always passes `{}`
    let host: string | null = null
    if (r.ok) {
      state.links = (state.links ?? 0) + 1
      if (state.links <= MAX_LINKS) host = r.host
    }
    for (let j = idx + 1; j < tokens.length; j++) {
      if (tokens[j]!.type === 'link_close') {
        tokens[j]!.meta = host ? { host } : null
        break
      }
    }
    if (!host || !r.ok) return ''
    return `<a class="cms-ext" href="${esc(r.href)}" target="_blank" rel="noopener noreferrer nofollow ugc">`
  }
  md.renderer.rules.link_close = (tokens, idx) => {
    const host = (tokens[idx]!.meta as { host?: string } | null)?.host
    return host ? ` <span class="cms-ext-host">${esc(host)} ↗</span></a>` : ''
  }
  return md
}

let md: Md | undefined
const getMd = () => (md ??= createMd())

/**
 * Reject HTML, images, bare URLs and any link that is not a valid `[text](https://…)` (https only, no shorteners or
 * IP hosts, at most MAX_LINKS, link text must not impersonate another site).
 */
export function checkExplanation(src: string, path = 'explanation'): FieldError[] {
  const errors: FieldError[] = []
  const add = (code: string, message: string, params?: Record<string, number>) => {
    if (!errors.some((e) => e.code === code)) errors.push({ path, code, message, ...(params ? { params } : {}) })
  }
  if (HTML_RE.test(src)) add('md_html', 'HTML is not allowed.')
  if (IMAGE_OR_REFDEF_RE.test(src)) add('md_link', LINK_HELP)

  let links = 0
  let cur: { href: string; text: string } | null = null
  const scanInline = (children: Tok[]) => {
    for (const t of children) {
      if (t.type === 'link_open') {
        links++
        cur = { href: String(t.attrGet('href') ?? ''), text: '' }
      } else if (t.type === 'link_close' && cur) {
        const r = normalizeExplanationLink(cur.href)
        if (!r.ok) add('md_link_invalid', r.message)
        else {
          const problem = linkTextProblem(cur.text, r.host)
          if (problem) add('md_link_text', problem)
        }
        cur = null
      } else if (t.type === 'text' || t.type === 'code_inline') {
        if (cur) cur.text += t.content
        else if (STRAY_LINK_RE.test(t.content)) add('md_link', LINK_HELP)
      } else if (cur && (t.type === 'softbreak' || t.type === 'hardbreak')) {
        cur.text += ' '
      }
    }
  }
  for (const t of getMd().parse(src, {})) {
    if (t.type === 'inline') scanInline(t.children ?? [])
    else if ((t.type === 'fence' || t.type === 'code_block') && STRAY_LINK_RE.test(t.content)) add('md_link', LINK_HELP)
  }
  if (links > MAX_LINKS) add('md_link_limit', `At most ${MAX_LINKS} links are allowed.`, { max: MAX_LINKS })
  return errors
}

/** Render explanation markdown to safe HTML (only validated https links, never <img> or raw HTML). */
export function renderExplanation(src: string): string {
  return getMd().render(src, {})
}
