import { isLang, langFromTag, resolveUiLang } from '../../src/shared/i18n.ts'
import { normalizeFormOptions } from './form-api.ts'
import { loaderStrings } from './i18n/loader.ts'
import type { ListOpts } from './shared.ts'

// Tiny public loader: finds [data-cms-type] hosts, and imports the list chunk the first time a host
// nears the viewport. It also exposes `window.cmsEmbed.openForm()` for hosts that draw their own list.
// No framework, never throws into the host page.
type Host = HTMLElement & { _cms?: 1 }
interface CmsEmbed {
  (): void
  openForm?: (options: unknown) => Promise<void>
}
const w = window as unknown as { cmsEmbed?: CmsEmbed }

const origin = new URL(import.meta.url).origin

/** Public API: opens the submission form dialog inside `options.host`. Rejects instead of throwing. */
async function openForm(options: unknown): Promise<void> {
  const r = normalizeFormOptions(options, origin, resolveUiLang)
  if (r instanceof Error) throw r
  r.host.classList.add('cms-submissions')
  const m = await import('./form.tsx')
  m.openForm(r)
}

function createScan(): () => void {
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

  return () => {
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
}

try {
  if (w.cmsEmbed) {
    // Script included twice (or an older loader is present): re-scan, and make sure `openForm` exists.
    w.cmsEmbed.openForm ??= openForm
    w.cmsEmbed()
  } else {
    const scan = createScan()
    // Assigned synchronously, so `openForm` is available as soon as the module has been imported.
    w.cmsEmbed = Object.assign(() => scan(), { openForm })
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan)
    else scan()
  }
} catch (e) {
  console.error('[wiki-cms] embed failed to start', e)
}
