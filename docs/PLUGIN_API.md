# Plugin API (v1)

A **plugin** teaches the generic wiki-cms UI how to show and edit the type-specific `payload` of one submission type (for LAH: a team formation). The rest of the UI (list, tags, language, explanation, demo link, form shell, Turnstile, moderation) is generic and is **not** the plugin's job.

Source of truth for the types: `src/shared/plugin-api.ts`. Copy that file verbatim into the plugin repo (it has no runtime imports).

## What a plugin is

One ES module, served by the wiki (any static host), whose **default export** is a `SubmissionPlugin`:

```ts
import type { SubmissionPlugin } from './plugin-api.ts'

const plugin: SubmissionPlugin<MyPayload> = {
  apiVersion: 1,                 // anything else is rejected by the embed and the admin portal
  type: 'lah-team-formation',    // must equal data-cms-type / the submission type id
  defaultPayload() { … },
  mountSummary(el, payload, ctx) { …; return cleanup },
  mountDetail(el, payload, ctx)  { …; return cleanup },
  mountEditor(el, { value, onChange, errors }, ctx) { …; return handle },
}
export default plugin
```

The module may import its own chunks (`import()` / Vite chunks next to it) and may bundle its own Preact. It must be loadable **cross-origin** (the embed imports it from the wiki page's own origin; the admin portal imports it from the Worker origin, so the host must send `Access-Control-Allow-Origin: *` or an allowed origin; GitHub Pages does).

### Who loads it, and how

| Consumer | When | How |
|---|---|---|
| Public embed | once per page, when the first list renders (and again for the form; memoized by URL) | `import(new URL(data-cms-plugin, document.baseURI).href)`; the module must have `apiVersion === 1` and the mount functions. If it fails, each card shows a localized "Team details unavailable" and the rest of the list still renders; the form shows "the editor could not be loaded" and cannot submit. |
| Admin portal | once per type | `import(type.pluginUrl)` (the `plugin_url` stored in D1 by `cms type add/update`). If it fails, the payload is shown as raw JSON. English only (`uiLang: 'en'`). |

## `PluginContext`

```ts
interface PluginContext {
  uiLang: 'en' | 'zh-Hans' | 'zh-Hant' | 'ja'
  theme: 'light' | 'dark'
  group: { id: string; options: Record<string, unknown> }
}
```

- `uiLang`: resolved UI language. The plugin owns its own string bundles and **falls back to `en`** for any missing key. Add a unit test that every key of the `en` bundle exists in the other three. The embed also passes the same value to its own UI; the admin portal always passes `'en'`.
- `theme`: informational snapshot at mount time (`[data-theme]` on `<html>`, else `prefers-color-scheme`). Do not re-render on theme changes; style with CSS (see below).
- `group.options`: the group's registry options. They are type-specific and opaque to the core (LAH: `{ support?: boolean | 'optional'; focus?: { kind: 'hero' | 'sidekick'; stockId: number }; targets?: Target[] }`; `support` absent or `true` means a borrowed support is required, `false` that none is allowed, `'optional'` that it may be left out; see [Type-specific group options](#type-specific-group-options-lah-targets)). **Never parse `group.id`**; everything the plugin needs is in `options`. In the embed it comes from the list blob (`groupOptions`), in the admin portal from the submission's group.

## Mount lifecycle and cleanup

All mount functions are framework-agnostic: DOM element in, cleanup out. The host owns `el` and gives it to you empty; render only inside it.

- `mountSummary(el, payload, ctx): () => void` renders the compact card view (hero icons) **and owns its own full-detail `<dialog>`** opened on click. Create the `<dialog>` as a child of `el` (not `document.body`), so the theme variables inherit (`::backdrop` does not inherit custom properties; hard-code a neutral translucent backdrop). The cleanup function must close/remove everything you created, including timers and global listeners. The host calls it when the card is removed, when the list re-renders for another language, and before remounting. The host also empties `el` afterwards.
- `mountDetail(el, payload, ctx): () => void` is the full read-only view (the admin portal shows it inline; `mountSummary`'s dialog should reuse it).
- `mountEditor(el, { value, onChange, errors }, ctx): EditorHandle` mounts the editor for the form, starting from `value` (initially `defaultPayload()`, or a restored draft's payload; if `value` is not something your editor can show, throw: the embed then retries once with `defaultPayload()`).
  - Call `onChange(payload)` with a **complete, normalized** payload every time it changes. Emit payloads that already satisfy the group-level rules where possible (e.g. keep `supportIndex` pointing at the same slot after reordering; make it `null` when `ctx.group.options.support === false`).
  - `errors` is the initial error list (usually `[]`).
  - `EditorHandle.destroy()`: unmount and release everything.
  - `EditorHandle.validate(): FieldError[]`: client-side mirror of the server rules. The form calls it before submitting and blocks the submit if it returns errors (it then calls `setErrors` with them). Keep it in sync with `src/types/<type>/validate.ts`.
  - `EditorHandle.setErrors(errors)`: render the given errors inline (replace any previous ones). `[]` clears them. The form calls it with the `payload` / `payload.*` entries of the server's `validation_failed.error.fields`, and clears it when the user edits the team again.
- The editor should be usable at 360 px width, keyboard accessible, and must not trap the `Esc` key of the surrounding `<dialog>` (nested dialogs of your own may handle `Esc` themselves).

## Optional: `listFilter` (catalog layout)

A plugin may add game-specific filters and sorts to the embed's `catalog` layout (`data-cms-layout="catalog"`, `docs/EMBED.md`) by exporting `listFilter` (`ListFilter<P, S>` in `src/shared/plugin-api.ts`). It is optional and backward compatible (`apiVersion` stays 1): without it only the core filters (title search, tags, language, sort) are offered. The core treats the state `S` as opaque.

| Member | Contract |
|---|---|
| `init(params, ctx): S` | Initial state from the hash params the plugin owns (the core reserves `q`, `sort`, `lang` and `t.*`). Called after `prepare()`, on `hashchange`, and with empty params for "Clear filters". |
| `toParams(state)` | The **non-default** values as hash params. An empty result means "no plugin filter is active" (the core uses that to show "Clear filters"). |
| `prepare?()` | Awaited once before the first filtering (load the roster here). A rejection is logged and ignored. |
| `mount(el, part, state, onChange, ctx)` | Render the controls of `'basic'` (next to the search box, always visible) or `'advanced'` (inside the collapsible panel; mounted even while collapsed) into `el`. Returns `{ update(state), destroy() }`. `update` is called on every state change, including the echo of your own `onChange` and "Clear filters": keep it idempotent and never call `onChange` from it. Both parts are destroyed and remounted when the UI language (`ctx.uiLang`) changes. |
| `test(payload, state)` | Pure and cheap; the payload is the published, server-validated JSON. |
| `activeCount(state)` | Active filters of the **advanced** part only (badge on the core's "Advanced filters" toggle). |
| `sorts?` | `{ key, label(lang), compare(a, b) }[]` over payloads. The key is written as `sort=<key>`. Ties are broken by newest first. |

Errors thrown by `init`, `test`, `compare`, `toParams` or `activeCount` are caught: the item counts as matching, and the error is logged once. The core stylesheet's generic classes (`cms-chip`, `cms-chip-btn` + `cms-active` with `aria-pressed`, `cms-btn`, `cms-input`, `cms-label`, `cms-hint`) and theme variables may be reused inside your parts; the LAH plugin ships its own self-contained `cms-lah-*` styles instead.

## Type-specific group options (LAH `targets`)

The wiki's registry (`/api/cms-groups.json`) gives each group a free-form `options` object that the core passes untouched to the validator, the plugin and the blob (`groupOptions`). The LAH Team Creator uses one group, `all`:

```jsonc
"all": {
  "title": "Team Creator", "url": "/team-creator.html",
  "options": {
    "support": "optional",
    "targets": [
      { "id": "quest-616001", "label": { "en": "Simulator - Lantern-type Kaibutsu (SSS)", "ja": "…" }, "url": "/guide/challenge_simulator/" },
      { "id": "quest-605001", "label": { "en": "…" }, "retired": true }
    ]
  }
}
```

- `id` matches `^[a-z0-9][a-z0-9-]{0,63}$`, is unique and **permanent** (stored in payloads and links). By convention `quest-<questId>` or `rogue-<event>`; nothing outside the wiki relies on that.
- `label`: one or more of the four languages; the plugin falls back from the UI language to `en`, then `ja`, then any language present. `url` optionally links the target chip. `retired: true` hides the target from the submit form but keeps it valid and filterable. **Never delete** a target that rows use (they would fail validation when a moderator edits them): retire it.
- `payload.target` is optional (absent or `null` = general purpose) and must be the `id` of a listed entry, otherwise the validator reports `target_unknown` at `payload.target`. The core never interprets the id.
- The array order is the order of the picker and the filter.
- Adding or renaming a target is a **wiki-only change**: the hourly cron refetches the registry, sees that `all`'s options changed and republishes the blob. To make it live at once run `cms republish --type lah-team-formation`.
- The wiki repo's `docs/CMS.md` is the source of truth for how front matter turns into targets.

## Field errors (`FieldError`)

```ts
interface FieldError { path: string; code: string; message: string; params?: Record<string, string | number> }
```

- The server sends payload errors with `path` starting `payload` (`payload.supportIndex`, `payload.heroes`, `payload.heroes.2.passives`, …), a stable `code`, an English `message`, and `params` for interpolation (e.g. `duplicate_hero` with `{ slots: "1,3" }`).
- **`setErrors` receives the paths exactly as the server returns them (prefixed with `payload`).** Be tolerant: accept both `payload.heroes.0.stockId` and `heroes.0.stockId`.
- **`validate()` may return paths with or without the `payload.` prefix**; the embed normalizes by adding the prefix when it is missing. Use `code`/`params` identical to the server's so that the two sources render the same text.
- Render each error from `code` + `params` in `ctx.uiLang` from your own bundle; if the code is unknown, fall back to `message`.
- Generic field errors (`lang`, `tags.*`, `explanation`, `demoUrl`, `payload_invalid`, `payload_too_large`) are localized by the embed itself; the plugin only needs its own `payload.*` codes.

## i18n bundle expectations

- Four bundles `en`, `zh-Hans`, `zh-Hant`, `ja` (`Lang` from `src/shared/i18n.ts`), `en` is the source of truth; lookups fall back to `en`.
- Game terminology (P.Lv, engravement, bloom, skill tree, fans, support, sidekick, …) must come from the wiki's official localized terms, not machine translation.
- Dates/numbers: `Intl.*` with `ctx.uiLang`.

## Styling

- Inject your CSS **once**: `?inline` import + `<style id="cms-plugin-<type>">` appended to `document.head` if not already present. Prefix every class (`lah-…`) so wiki CSS cannot collide.
- Use these variables (all set on / inherited through the host element `.cms-submissions`, which the embed's `<dialog>`s also live inside; **always give a fallback**, light values below):

  | Variable | Light fallback | Dark default | Use |
  |---|---|---|---|
  | `--cms-fg` | `CanvasText` | `#e6e6e6` | text |
  | `--cms-bg` | `Canvas` | `#1b1d21` | surfaces |
  | `--cms-border` | `#8884` | `#ffffff33` | borders |
  | `--cms-accent` | `#2563eb` | `#6ea8fe` | focus, selection |
  | `--cms-muted` | `#6b7280` | `#9ca3af` | secondary text |
  | `--cms-chip-bg` | `#8882` | `#ffffff1f` | chips/badges |
  | `--cms-support-bg` | `#d9f4f7` (light cyan) | `#1d4a52` | **the support slot** |
  | `--cms-danger` | `#c62828` | `#ff8a80` | errors |
  | `--cms-on-accent` | `#fff` | `#0b1220` | text on `--cms-accent` |

  e.g. `background: var(--cms-support-bg, #d9f4f7)`. The support slot must be cyan in the summary, detail dialog and editor, in both themes. The admin portal is expected to define the same variable names; the fallbacks keep plugins readable either way.
- Dark mode: follow the `html[data-theme="dark"]` convention (and `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])`). Do not rely on `ctx.theme`.
- Touch targets ≥ 40 px, visible focus rings, respect `prefers-reduced-motion`.

## Data and URLs

The plugin runs on the wiki **and** on the Worker origin. Resolve every data URL relative to the module (`new URL('../team-roster.json', import.meta.url)` or an absolute wiki URL), never against `location`. Cache fetched data at module level (the same plugin instance serves many cards).

## Minimal example

```js
// my-plugin.js — a plugin whose payload is { v: 1, name: string }
const T = {
  en: { name: 'Name', empty: 'Please enter a name.' },
  ja: { name: '名前', empty: '名前を入力してください。' },
}
const tx = (lang) => ({ ...T.en, ...T[lang] })

function injectCss() {
  if (document.getElementById('cms-plugin-my-type')) return
  const s = document.createElement('style')
  s.id = 'cms-plugin-my-type'
  s.textContent = '.my-chip{padding:.2rem .6rem;border-radius:6px;background:var(--cms-chip-bg,#8882)}'
  document.head.appendChild(s)
}

export default {
  apiVersion: 1,
  type: 'my-type',
  defaultPayload: () => ({ v: 1, name: '' }),

  mountSummary(el, payload, ctx) {
    injectCss()
    const chip = document.createElement('span')
    chip.className = 'my-chip'
    chip.textContent = payload.name
    el.appendChild(chip)
    return () => chip.remove()
  },
  mountDetail(el, payload) {
    el.textContent = JSON.stringify(payload)
    return () => el.replaceChildren()
  },
  mountEditor(el, { value, onChange }, ctx) {
    injectCss()
    const L = tx(ctx.uiLang)
    const label = document.createElement('label')
    label.textContent = L.name + ' '
    const input = document.createElement('input')
    input.value = value.name
    const err = document.createElement('p')
    label.append(input)
    el.append(label, err)
    input.addEventListener('input', () => onChange({ v: 1, name: input.value }))
    return {
      destroy: () => (label.remove(), err.remove()),
      validate: () => (input.value.trim() ? [] : [{ path: 'payload.name', code: 'name_empty', message: T.en.empty }]),
      setErrors: (errors) => {
        err.textContent = errors.map((e) => (e.code === 'name_empty' ? L.empty : e.message)).join(' ')
        input.setAttribute('aria-invalid', errors.length ? 'true' : 'false')
      },
    }
  },
}
```

A fuller stub that exercises everything (support-slot highlight, dialog, error mapping) lives in `embed/dev-plugin.js`; run it with `node embed/dev-server.mjs` (see `docs/EMBED.md`).
