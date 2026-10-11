import MarkdownIt from 'markdown-it'
import type { FieldError } from './plugin-api.ts'

const FORBIDDEN: { code: string; message: string; re: RegExp }[] = [
  { code: 'md_html', message: 'HTML is not allowed.', re: /<\/?[A-Za-z][^>]*>|<!--|<![A-Za-z]/ },
  { code: 'md_link', message: 'Links are not allowed — put your video in the Demo link field.', re: /\]\(|^\s{0,3}\[[^\]]+\]:\s*\S|!\[|<[a-z][a-z0-9+.-]*:|\b[a-z][a-z0-9+.-]*:\/\/|\bwww\./im },
]

/** Reject HTML, links and images in explanation markdown. */
export function checkExplanation(md: string, path = 'explanation'): FieldError[] {
  const errors: FieldError[] = []
  for (const rule of FORBIDDEN) {
    if (rule.re.test(md)) errors.push({ path, code: rule.code, message: rule.message })
  }
  return errors
}

type Md = InstanceType<typeof MarkdownIt>

function createMd(): Md {
  const md = new MarkdownIt({ html: false, linkify: false, breaks: true, typographer: false })
  md.disable(['link', 'image', 'autolink', 'html_block', 'html_inline', 'reference'])
  // Community headings must never compete with the wiki's h2: remap h1/h2 → h3/h4 and clamp at h6.
  md.core.ruler.push('cms_heading_levels', (state) => {
    for (const tok of state.tokens) {
      if (tok.type !== 'heading_open' && tok.type !== 'heading_close') continue
      const level = Math.min(Number(tok.tag.slice(1)) + 2, 6)
      tok.tag = `h${level}`
    }
    return true
  })
  return md
}

let md: Md | undefined

/** Render explanation markdown to safe HTML (never emits <a>, <img> or raw HTML). */
export function renderExplanation(src: string): string {
  md ??= createMd()
  return md.render(src)
}
