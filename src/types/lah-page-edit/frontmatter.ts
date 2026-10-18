// Jekyll/Eleventy front matter: a `---` line at the very start, a closing `---` line, and the page body after it.

const FENCE = /^---[ \t]*$/

export interface SplitPage {
  /** Both fences and the line break after the closing one, byte for byte ('' when the page has no front matter). */
  frontMatter: string
  body: string
}

/** True when the text starts with a front matter fence line (`---`). */
export function startsWithFence(text: string): boolean {
  return /^---[ \t]*(\r?\n|$)/.test(text)
}

/** Splits a page into its front matter (kept exactly, including the closing fence's line break) and its body. */
export function splitFrontMatter(text: string): SplitPage {
  if (!startsWithFence(text)) return { frontMatter: '', body: text }
  let pos = text.indexOf('\n')
  if (pos === -1) return { frontMatter: '', body: text } // a lone `---`: no closing fence
  pos += 1
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos)
    const end = nl === -1 ? text.length : nl
    const line = text.slice(pos, end).replace(/\r$/, '')
    const next = nl === -1 ? text.length : nl + 1
    if (FENCE.test(line)) return { frontMatter: text.slice(0, next), body: text.slice(next) }
    if (nl === -1) break
    pos = next
  }
  return { frontMatter: '', body: text } // unclosed: not front matter
}

export function joinFrontMatter(frontMatter: string, body: string): string {
  return frontMatter + body
}
