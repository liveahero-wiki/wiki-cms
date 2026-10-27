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
3. Sample submissions: `node scripts/dev-seed.mjs --reset` (several groups, so the group filter shows; one pending contributor edit).

For the production shape — one group, so the admin hides every group control — pass `--single-group` to **both** (the registry decides whether the filter appears, the seed where the rows live): `node admin/dev/serve-fixtures.mjs --single-group` and `node scripts/dev-seed.mjs --reset --single-group`. The Worker caches the registry in KV for 5 minutes, so restart `wrangler dev` after switching.
4. Worker: `CMS_DEV_ASSETS=1 pnpm build:admin && pnpm exec wrangler dev --port 8787`.
5. Sign in without Discord: `node scripts/dev-login.mjs [userId] [--types lah-team-formation]` prints a `document.cookie = "..."` line. Paste it in the browser console on `http://localhost:8787` and reload. A user created with `--types=` (empty) has no permissions (tests the empty state).

Local-only limitations: the cache purge fails locally, so moderation actions show the "cache purge failed" warning; Discord sign-in itself cannot be completed locally (the sign-in button only gets as far as Discord's authorize URL).

## Plugin loading and the dev override

The portal imports `type.pluginUrl` once per type. On `localhost` the `?plugin=<url>` query parameter overrides it (remembered for the tab in `sessionStorage`).

The built admin's CSP (`public/_headers`) only allows `'self'` and the wiki origin as script sources, so a plugin on `http://localhost:8080` is blocked on port 8787. For the stub plugin use the same origin:

- `CMS_DEV_ASSETS=1 pnpm build:admin` also emits `admin/dev/stub-plugin.js` as `/dev/stub-plugin.js` (never emitted without the variable), then open `http://localhost:8787/?plugin=/dev/stub-plugin.js`.
- With `pnpm dev:admin` (Vite on 5173, no CSP) both `?plugin=/dev/stub-plugin.js` and the default `http://localhost:8080/assets/cms/stub-plugin.js` work, but mutations fail the same-origin check (`Origin` must equal `PUBLIC_URL`); use 8787 for those.

A plugin that cannot be loaded or that throws degrades to a raw JSON view (and a JSON editor in the edit dialog) while the rest of the portal keeps working.

## A type page

`/t/<type>` is the submission list: tabs **Pending · Approved · Spam · Contributor edits** (`?state=`, `?tab=edits`), counts on each. The pending counts also sit in the sidebar, next to every type and next to its *Contributor edits* link, so work waiting for review is visible without opening a type; contributor edits get the warm-coloured pill. They come from `GET /me` and are refreshed with the lists after every moderation action.

Groups are **not** a navigation level. Every LAH type lives in the single group `all` (the registry's title and `url` describe the Team Creator page, which says nothing about a page edit or a translation), so the admin hides group chrome: no groups table, no group page, no group chip on cards, no group picker in the edit dialog. Nothing about the data model changed — `group_id`, the registry and `options` are untouched, and as soon as a type has more than one group the submission list grows a **Group** filter (`?group=`), the cards show their group again and the edit dialog can move a submission. The retired `/t/<type>/g/<group>` url redirects to the filtered list, so old links and Discord notifications still land somewhere sensible.

## Names (titles)

Types that define a name (`SubmissionTypeDef.title`) show it on every card; legacy items without one get an "Untitled" warning badge and an **"Untitled only"** checkbox on the list filters them (client-side, over the loaded page). The edit dialog has a name input (4–50 characters for LAH, plain text, no links; server errors map to the input). A legacy untitled item needs a name before it can be edited, which is how moderators backfill them. The "original" view shows the pre-edit name and tolerates tag keys that no longer exist (it prints `key: value`).

## Contributor accounts: owners and edits

Contributors (signed in on the public site) can edit their own approved submissions. An edit is stored as a pending *revision*; the published version stays live until a moderator approves it.

- **Owner**: every submission card shows who submitted it (display name, with the provider account such as `Discord 123456…` in a small style) or "Anonymous (legacy)" when the owner is null. A card with a pending edit also gets an **Edit pending** badge that links to the edits view.
- **Assign / change owner** (card action): opens a dialog with a contributor search (`GET /contributors?q=`, at least 2 characters; display name, provider account id or user id). Pick a result and confirm to `POST /submissions/:id/owner`; **Clear owner** sends `userId: null`. Used to give a legacy anonymous submission to a contributor on request. Errors are shown inline in the dialog.
- **Contributor edits** (the last tab on a type page, and its own sidebar link with a pending count, `?tab=edits`, state filter `&edits=pending|approved|rejected|withdrawn`): each item lists the published and the proposed values side by side (name, content via the plugin's summary/detail view, tags, language, demo URL, explanation), marks the changed fields (`admin/src/revisions.ts`, unit tested) and shows who proposed it. If `baseVersion` is lower than the submission's current `version`, a warning says a moderator changed the submission in the meantime and approving overwrites it.
  - **Approve** sends `expectedVersion = submission.version`; **Reject** opens an inline textarea for an optional reason (500 characters max). Decided items leave the pending list; a cache `purgeWarning` is shown as a toast like for other actions.
  - A `409` (`version_conflict` when a moderator changed the submission, `not_pending` when the edit was already decided or withdrawn) shows the server message and reloads the list.

## Notes for plugin authors

- `ctx = { uiLang: 'en', theme, group: { id, options } }`; `options` comes from the groups registry (`AdminGroup.options`) of the submission's group (of the chosen group in the edit dialog; the editor is re-mounted with the current value when the group changes).
- The admin root defines `--cms-bg`, `--cms-fg`, `--cms-border`, `--cms-accent`, `--cms-muted`, `--cms-chip-bg`, `--cms-support-bg` and uses `html[data-theme="light|dark"]`.
- Server field errors whose path starts with `payload` are passed to `EditorHandle.setErrors` unchanged (full paths such as `payload.heroes.0.stockId`); `validate()` results are shown as returned and block saving.
