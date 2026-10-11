import { isLang, langFromTag, resolveUiLang } from '../../src/shared/i18n.ts'
import { loaderStrings } from './i18n/loader.ts'
import type { ListOpts } from './shared.ts'

// Tiny public loader: finds [data-cms-type] hosts, and imports the list chunk the first time a host
// nears the viewport. No framework, never throws into the host page.
type Host = HTMLElement & { _cms?: 1 }
const w = window as unknown as { cmsEmbed?: () => void }

function init() {
  const origin = new URL(import.meta.url).origin

  const text = (el: Host, key: 'loading' | 'failed' | 'retry') => loaderStrings[resolveUiLang(el)][key]

  const placeholder = (el: Host, msg: string, retry?: () => void) => {
    const p = document.createElement('p')
    p.className = 'cms-placeholder'
    p.setAttribute('role', 'status')
    p.textContent = msg
    if (retry) {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = text(el, 'retry')
      b.onclick = retry
      p.appendChild(document.createTextNode(' ')), p.appendChild(b)
    }
    el.replaceChildren(p)
  }

  const load = (el: Host) => {
    placeholder(el, text(el, 'loading'))
    import('./list.tsx').then(
      (m) => {
        const d = el.dataset
        const opts: ListOpts = { api: (d.cmsApi || origin).replace(/\/+$/, ''), type: d.cmsType!, group: d.cmsGroup || '', plugin: d.cmsPlugin || null }
        m.mountList(el, opts)
      },
      () => placeholder(el, text(el, 'failed'), () => load(el)),
    )
  }

  const io =
    'IntersectionObserver' in window
      ? new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              if (!e.isIntersecting) continue
              io!.unobserve(e.target)
              load(e.target as Host)
            }
          },
          { rootMargin: '400px' },
        )
      : null

  const scan = () => {
    for (const el of document.querySelectorAll<Host>('[data-cms-type]')) {
      if (el._cms) continue
      el._cms = 1
      el.classList.add('cms-submissions')
      // Language hook: the host element (or an ancestor) may dispatch `cms:lang` before the chunk is loaded.
      const onLang = (e: Event) => {
        const d = (e as CustomEvent).detail
        const l = typeof d === 'string' ? (isLang(d) ? d : langFromTag(d)) : null
        if (l) el.setAttribute('data-cms-lang', l)
      }
      el.addEventListener('cms:lang', onLang)
      placeholder(el, text(el, 'loading'))
      if (io) io.observe(el)
      else load(el)
    }
  }

  w.cmsEmbed = scan
  scan()
}

try {
  if (w.cmsEmbed) w.cmsEmbed()
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
} catch (e) {
  console.error('[wiki-cms] embed failed to start', e)
}
