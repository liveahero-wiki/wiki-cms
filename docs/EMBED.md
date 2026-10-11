# Public embed

The embed is the generic public UI (disclaimer, submission list, filters, submit form, Turnstile) served by the wiki-cms Worker from static assets. A wiki only adds a placeholder `div`, one script tag and a **plugin** (`docs/PLUGIN_API.md`).

## Host markup

```html
<div class="cms-submissions"
     data-cms-api="https://wiki-cms.<sub>.workers.dev"
     data-cms-type="lah-team-formation"
     data-cms-group="quest-1272003"
     data-cms-plugin="/assets/cms/lah-team-formation.js"></div>
<script type="module" src="https://wiki-cms.<sub>.workers.dev/embed/v1.js"></script>
```

| Attribute | Required | Meaning |
|---|---|---|
| `data-cms-type` | yes | Submission type id. Marks the element as an embed host. |
| `data-cms-group` | yes | Group id (opaque to the embed; must exist in the wiki's groups registry for submissions to be accepted). |
| `data-cms-plugin` | yes | URL of the plugin module, resolved against `document.baseURI`. |
| `data-cms-api` | no | Worker origin. Defaults to the origin the loader script was served from. |
| `data-cms-lang` | no | UI language override: `en`, `zh-Hans`, `zh-Hant`, `ja` (or a BCP-47 tag such as `ja-JP`, `zh-TW`). |

The `cms-submissions` class is optional (the loader adds it). The page heading belongs to the host page; the embed renders everything below it.
The script may be included more than once on a page (a global guard makes later copies just re-scan for new hosts).

## Loading behavior

1. `v1.js` (about 2 KB gzip, no framework) finds all `[data-cms-type]` elements and shows a small localized placeholder.
2. An `IntersectionObserver` (`rootMargin: 400px`) loads the list chunk the first time a host nears the viewport. Hosts inside hidden tab panels (`display: none`) do not intersect, so they load when they become visible. Nothing but `v1.js` is requested before that.
3. The list chunk (Preact + i18n + CSS) is imported from `chunks/list-<hash>.js` relative to `v1.js`, fetches `GET {api}/api/v1/submissions/{type}/{group}`, and imports the plugin once per page.
4. The form chunk (`chunks/form-<hash>.js`, includes markdown-it) and Cloudflare Turnstile are only loaded when someone clicks the submit button.
5. Hosts added to the page later: call `window.cmsEmbed()` to scan again.

Failures never throw into the host page: a failed list/chunk load shows a localized message with a retry button; a failed plugin only affects the team display of each card.

## HTTP caching

- The list URL is always the canonical `GET /api/v1/submissions/{type}/{group}` with **no query string** (Workers Cache keys include the query). Do not add cache-busting parameters; the embed uses the browser's default HTTP cache (the server sends `max-age=300, stale-while-revalidate=3600`; moderator changes can therefore take a few minutes to show up).
- `GET /api/v1/types/{type}` (config: tags, templates, disclaimer override, Turnstile site key) is fetched once per page (in the background for the disclaimer, and again by the form from the memo).
- `v1.js` is cached for 5 minutes, chunks are immutable (`public/_headers`).
- `POST` requests are cross-origin JSON requests (`Content-Type: application/json` only), so browsers send a CORS preflight; the Worker answers it only for the type's `allowed_origins`.

## UI language and the `cms:lang` hook

Resolution (first match wins): `data-cms-lang` on the host element → `<html lang>` → `navigator.language` (`ja*` → `ja`, `zh-TW/HK/MO/Hant*` → `zh-Hant`, other `zh*` → `zh-Hans`) → `en`. The same value is passed to the plugin as `ctx.uiLang`.

To change the language after load, set `data-cms-lang` on the host element(s) and dispatch a `cms:lang` `CustomEvent`:

```js
for (const el of document.querySelectorAll('[data-cms-type]')) {
  el.setAttribute('data-cms-lang', 'ja')
  el.dispatchEvent(new CustomEvent('cms:lang', { detail: 'ja' }))
}
```

- `detail` is optional: a `Lang` or a tag (`'ja-JP'`). When valid, the embed also writes it to `data-cms-lang`; otherwise it simply re-resolves.
- The event may also be dispatched on `document`/`documentElement` (any ancestor, bubbling): the embed handles events dispatched on an ancestor of the host.
- Listeners are attached when the list chunk mounts; before that the host's current `data-cms-lang` is simply read at mount.
- The wiki integration (e.g. lah-wiki's `data-skill-lang` switch) should set `data-cms-lang` on the host element(s) and dispatch `cms:lang` from its own language-change handler. The embed does not read `data-skill-lang` itself.
- An open form dialog keeps the language it was opened with; the explanation language selector in the form is independent (default `en`).

## Theming

CSS is injected once into `<style id="cms-embed-style">`; every class is prefixed `cms-`. Colors are variables with fallbacks, so a wiki can override them in its own stylesheet **on `.cms-submissions`** (or the host element):

```css
.cms-submissions {
  --cms-fg: #222;           /* text */
  --cms-bg: #fff;           /* card / dialog background */
  --cms-border: #8884;
  --cms-accent: #2563eb;    /* buttons, focus rings, selected chips */
  --cms-muted: #6b7280;     /* secondary text */
  --cms-chip-bg: #8882;
  --cms-support-bg: #d9f4f7; /* support slot (used by plugins) */
  --cms-danger: #c62828;    /* errors */
  --cms-on-accent: #fff;    /* text on --cms-accent */
}
```

Dark defaults apply under `[data-theme="dark"] .cms-submissions` and under `@media (prefers-color-scheme: dark)` for `:root:not([data-theme="light"]) .cms-submissions`. They are declared with zero specificity (`:where`), so any rule of yours on `.cms-submissions` wins. Note that a dark default is a declaration on the host element itself: setting a variable only on `:root` or `body` would be shadowed in dark mode, so set overrides on `.cms-submissions` (also per theme, e.g. `[data-theme="dark"] .cms-submissions { … }`).

The submit form is a native `<dialog>` appended inside the host element, so inherited variables work; `::backdrop` cannot inherit and uses a fixed neutral translucent black.

## Submission form

Fields: team formation (plugin editor), every tag of the type (radio group, required ones are enforced), explanation language (default `en` regardless of UI language, with the "write in English if possible" hint), explanation (Markdown, template prefilled per language, Write/Preview, live counter and policy errors), demo link (https, allowed hosts only), hidden honeypot, privacy note, Turnstile. Server field errors are mapped to inputs by `path` and rendered in the UI language from `code`/`params` (fallback: the server's English `message`). An unsent draft is kept in `localStorage` under `cms-draft:<type>:<group>` (cleared on success). `Esc`/close asks for confirmation when the form has unsent content.

## Local development

```bash
pnpm build:embed          # writes dist/public/embed (do not run the admin build in parallel: it empties dist/public)
node embed/dev-server.mjs # http://localhost:8788/  (mock API + dev page + dev plugin + built embed)
```

The dev page (`embed/dev.html`) has hosts for a normal group (27 fixture items in all four languages, long explanations, three demo platforms), an empty group, an unknown group, a hidden panel (lazy loading) and a plugin that fails to load, plus language and dark-mode toggles. Magic explanation text for testing the form: `FAIL` (validation errors with sample fields), `RATE` (429), `CAP` (daily cap), `WEIRD` (unknown error code with an English message). Turnstile uses Cloudflare's always-pass test key `1x00000000000000000000AA`.
