# Admin portal: local development

The admin SPA lives in `admin/` (Preact + Vite) and is served at `/` by the Worker.

## Build / typecheck

```sh
pnpm build:admin            # writes dist/public (leaves dist/public/embed untouched)
pnpm exec tsc --noEmit
```

## Run it locally with data

1. Local DB with the migrations applied and a type row (see the CLI: `pnpm cms type add ...`; the dev type is `lah-team-formation`, origins `http://localhost:8080`, groups URL `http://localhost:8080/api/cms-groups.json`).
2. Fake wiki (groups registry + plugin): `node admin/dev/serve-fixtures.mjs` (port 8080).
3. Sample submissions: `node scripts/dev-seed.mjs --reset`.
4. Worker: `CMS_DEV_ASSETS=1 pnpm build:admin && pnpm exec wrangler dev --port 8787`.
5. Sign in without Discord: `node scripts/dev-login.mjs [userId] [--types lah-team-formation]` prints a `document.cookie = "..."` line. Paste it in the browser console on `http://localhost:8787` and reload. A user created with `--types=` (empty) has no permissions (tests the empty state).

Local-only limitations: the cache purge fails locally, so moderation actions show the "cache purge failed" warning; Discord sign-in itself cannot be completed locally (the sign-in button only gets as far as Discord's authorize URL).

## Plugin loading and the dev override

The portal imports `type.pluginUrl` once per type. On `localhost` the `?plugin=<url>` query parameter overrides it (remembered for the tab in `sessionStorage`).

The built admin's CSP (`public/_headers`) only allows `'self'` and the wiki origin as script sources, so a plugin on `http://localhost:8080` is blocked on port 8787. For the stub plugin use the same origin:

- `CMS_DEV_ASSETS=1 pnpm build:admin` also emits `admin/dev/stub-plugin.js` as `/dev/stub-plugin.js` (never emitted without the variable), then open `http://localhost:8787/?plugin=/dev/stub-plugin.js`.
- With `pnpm dev:admin` (Vite on 5173, no CSP) both `?plugin=/dev/stub-plugin.js` and the default `http://localhost:8080/assets/cms/stub-plugin.js` work, but mutations fail the same-origin check (`Origin` must equal `PUBLIC_URL`); use 8787 for those.

A plugin that cannot be loaded or that throws degrades to a raw JSON view (and a JSON editor in the edit dialog) while the rest of the portal keeps working.

## Names (titles)

Types that define a name (`SubmissionTypeDef.title`) show it on every card; legacy items without one get an "Untitled" warning badge and an **"Untitled only"** checkbox on the list filters them (client-side, over the loaded page). The edit dialog has a name input (4–50 characters for LAH, plain text, no links; server errors map to the input). A legacy untitled item needs a name before it can be edited, which is how moderators backfill them. The "original" view shows the pre-edit name and tolerates tag keys that no longer exist (it prints `key: value`).

## Notes for plugin authors

- `ctx = { uiLang: 'en', theme, group: { id, options } }`; `options` comes from the groups registry (`AdminGroup.options`) of the submission's group (of the chosen group in the edit dialog; the editor is re-mounted with the current value when the group changes).
- The admin root defines `--cms-bg`, `--cms-fg`, `--cms-border`, `--cms-accent`, `--cms-muted`, `--cms-chip-bg`, `--cms-support-bg` and uses `html[data-theme="light|dark"]`.
- Server field errors whose path starts with `payload` are passed to `EditorHandle.setErrors` unchanged (full paths such as `payload.heroes.0.stockId`); `validate()` results are shown as returned and block saving.
