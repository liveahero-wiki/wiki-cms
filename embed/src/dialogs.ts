// Sign-in dialogs drawn by the embed itself: the provider picker and the display-name prompt. Plain DOM in a shadow root
// (so the wiki's CSS cannot touch them and they bring no stylesheet of their own into the page), a native modal <dialog>
// (top layer: it also sits above the submission form's dialog). Lazy chunk, loaded by `signIn` in contrib-session.ts.
import { isLang, langFromTag, resolveUiLang, type Lang } from '../../src/shared/i18n.ts'
import { rename } from './contrib-api.ts'
import { apiErrorText, t } from './i18n/t.ts'
import { ApiError } from './shared.ts'

const uiLang = (lang?: string): Lang => (lang && (isLang(lang) ? lang : langFromTag(lang))) || resolveUiLang()

const CSS = `
:host { all: initial; }
dialog {
  box-sizing: border-box; width: min(24rem, calc(100vw - 2rem)); max-height: calc(100vh - 2rem); overflow: auto;
  margin: auto; padding: 1.25rem; border: 1px solid #8886; border-radius: 10px;
  background: #fff; color: #1f2328; font: 16px/1.45 system-ui, sans-serif;
}
dialog::backdrop { background: #0008; }
h2 { margin: 0 0 0.75rem; font-size: 1.1rem; }
p { margin: 0 0 0.75rem; }
.hint { color: #59636e; font-size: 0.9em; }
.error { color: #b42318; }
.list { display: grid; gap: 0.5rem; margin: 0 0 0.75rem; }
button, input { font: inherit; box-sizing: border-box; }
button { cursor: pointer; }
.provider {
  display: flex; align-items: center; gap: 0.75rem; width: 100%; min-height: 44px; padding: 0.4rem 0.9rem;
  border: 1px solid #8886; border-radius: 8px; background: transparent; color: inherit; text-align: start;
}
.provider:hover, .provider:focus-visible { border-color: #2563eb; outline: none; box-shadow: 0 0 0 2px #2563eb55; }
.provider svg { flex: none; width: 22px; height: 22px; }
.provider .name { flex: 1; }
.badge { font-size: 0.75em; padding: 0.05rem 0.5rem; border-radius: 999px; background: #8882; color: #59636e; }
.actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
.btn { min-height: 40px; padding: 0.35rem 0.9rem; border: 1px solid #8886; border-radius: 6px; background: transparent; color: inherit; }
.btn:disabled { opacity: 0.55; cursor: default; }
.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
label { display: block; margin-bottom: 0.25rem; font-weight: 600; }
input { width: 100%; min-height: 40px; padding: 0.35rem 0.6rem; border: 1px solid #8886; border-radius: 6px; background: transparent; color: inherit; }
@media (prefers-color-scheme: dark) {
  dialog { background: #1b1d21; color: #e6e6e6; }
  .hint, .badge { color: #9ca3af; }
  .error { color: #ff8a80; }
  .provider:hover, .provider:focus-visible { border-color: #6ea8fe; box-shadow: 0 0 0 2px #6ea8fe55; }
  .primary { background: #6ea8fe; border-color: #6ea8fe; color: #0b1220; }
}`

// Brand marks, kept inline: the picker must not depend on any request besides the provider list.
const ICONS: Record<string, string> = {
  google:
    '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>',
  discord:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#5865F2" d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg>',
}

type Props = Record<string, string | boolean | ((e: Event) => void)>

/** Tiny element builder: string props are attributes, `on*` props listeners, `class`/`textContent` as given. */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === 'function') el.addEventListener(k.slice(2), v)
    else if (v === true) el.setAttribute(k, '')
    else if (v !== false) el.setAttribute(k, v)
  }
  el.replaceChildren(...children)
  return el
}

/**
 * Shows a modal dialog in a closed shadow root. `build` fills it and gets `done(value)`; Esc and a click on the backdrop
 * resolve with `cancelled`.
 */
function modal<T>(lang: Lang, labelledBy: string, cancelled: T, build: (dlg: HTMLDialogElement, done: (v: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve) => {
    const host = h('div', { 'data-cms-dialog': '' })
    const root = host.attachShadow({ mode: 'closed' })
    const dlg = h('dialog', { 'aria-labelledby': labelledBy, lang })
    let settled = false
    const done = (v: T) => {
      if (settled) return
      settled = true
      if (dlg.open) dlg.close()
      host.remove()
      resolve(v)
    }
    dlg.addEventListener('close', () => done(cancelled)) // Esc
    dlg.addEventListener('click', (e) => {
      const r = dlg.getBoundingClientRect() // a click outside the box is on the backdrop
      if (e.target === dlg && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) done(cancelled)
    })
    build(dlg, done)
    root.replaceChildren(h('style', {}, CSS), dlg)
    document.body.appendChild(host)
    dlg.showModal()
  })
}

export interface PickOptions {
  providers: { id: string; label: string }[]
  /** Provider used last in this browser: listed first, focused and badged. */
  last: string | null
  lang?: string
}

/** Resolves with the chosen provider id, or null when the dialog was dismissed. Call `signIn`'s popup from the result's click, not later. */
export function pickProvider(opts: PickOptions): Promise<string | null> {
  const L = uiLang(opts.lang)
  const providers = [...opts.providers].sort((a, b) => Number(b.id === opts.last) - Number(a.id === opts.last))
  return modal<string | null>(L, 'cms-pick-title', null, (dlg, done) => {
    const buttons = providers.map((p) => {
      const icon = h('span', { 'aria-hidden': 'true' })
      icon.innerHTML = ICONS[p.id] ?? '' // constants above, never provider-supplied markup
      const b = h('button', { type: 'button', class: 'provider', onclick: () => done(p.id) }, icon.firstElementChild ?? '', h('span', { class: 'name' }, t(L, 'account.signInWith', { provider: p.label })))
      if (p.id === opts.last) b.appendChild(h('span', { class: 'badge' }, t(L, 'account.pickLast')))
      return b
    })
    dlg.replaceChildren(
      h('h2', { id: 'cms-pick-title' }, t(L, 'account.pickTitle')),
      h('div', { class: 'list' }, ...buttons),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onclick: () => done(null) }, t(L, 'form.cancel'))),
    )
    queueMicrotask(() => buttons[0]?.focus())
  })
}

let naming: Promise<boolean> | null = null

/**
 * Asks the signed-in contributor for a display name and saves it. Resolves true when saved, false when postponed
 * ("Later", Esc, backdrop); the session then keeps `needsDisplayName`. Only one dialog is open at a time.
 */
export function askDisplayName(opts: { api: string; lang?: string }): Promise<boolean> {
  if (naming) return naming
  const L = uiLang(opts.lang)
  naming = modal<boolean>(L, 'cms-name-title', false, (dlg, done) => {
    const input = h('input', { id: 'cms-name-input', type: 'text', maxlength: '64', autocomplete: 'off', 'aria-describedby': 'cms-name-hint' })
    const error = h('p', { class: 'error', role: 'alert', hidden: true })
    const save = h('button', { type: 'button', class: 'btn primary' }, t(L, 'account.save'))
    const submit = async () => {
      if (save.disabled) return
      const name = input.value.trim()
      const len = [...name].length
      const fail = (message: string) => {
        error.textContent = message
        error.hidden = false
        save.disabled = false
      }
      save.disabled = true
      error.hidden = true
      if (len < 2 || len > 32) return fail(t(L, 'account.nameInvalid'))
      try {
        await rename(opts.api, name)
        done(true)
      } catch (e) {
        if (e instanceof ApiError && e.code === 'validation_failed') fail(t(L, 'account.nameInvalid'))
        else fail(apiErrorText(L, e instanceof ApiError ? e.code : 'unknown'))
      }
    }
    input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), void submit()))
    save.addEventListener('click', () => void submit())
    dlg.replaceChildren(
      h('h2', { id: 'cms-name-title' }, t(L, 'account.nameTitle')),
      h('p', {}, t(L, 'account.nameIntro')),
      h('label', { for: 'cms-name-input' }, t(L, 'account.nameLabel')),
      input,
      h('p', { class: 'hint', id: 'cms-name-hint' }, t(L, 'account.nameHint')),
      error,
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onclick: () => done(false) }, t(L, 'account.later')), save),
    )
    queueMicrotask(() => input.focus())
  }).finally(() => (naming = null))
  return naming
}
