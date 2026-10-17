# wiki-cms

A small community-submissions CMS that runs as a single **Cloudflare Worker** on the free tier. It was built for the [Live A Hero wiki](https://github.com/liveahero-wiki/liveahero-wiki.github.io) (team formation submissions), but the core is game-agnostic: everything wiki-specific lives in a *submission type* plus a *plugin* hosted by the wiki.

- Repository: <https://github.com/liveahero-wiki/wiki-cms>
- Wiki that consumes it:
  - <https://github.com/liveahero-wiki/liveahero-wiki.github.io>

## What it does

- **Public embed**: a tiny loader (`/embed/v1.js`) that wiki pages include. It lazily loads a submission list and a submission form (with Turnstile) for each `data-cms-group` section on the page; a wiki that draws its own list can open the form through `window.cmsEmbed.openForm()`. The UI is localized (`en`, `zh-Hans`, `zh-Hant`, `ja`).
- **Public API** (`/api/v1/*`): reads are served from Workers Cache in front of a KV-materialized JSON blob per group; writes go to D1 after validation, markdown policy checks, Turnstile, IP rate limiting and blocklist checks.
- **Admin portal** (`/`): a Preact SPA for moderators (approve / mark spam / edit / bulk actions, invites, IP blocks, audit log). English only. Sign-in is Discord through [BetterAuth](https://www.better-auth.com/) with the `identify` scope only (no email).
- **CLI** (`cli/cms.ts`): register submission types, bootstrap invites, manage moderators and IP blocks, force cache republish.
- **Cron** (hourly): purges old spam/audit rows/invites/sessions, nulls old raw IPs, refreshes each type's group registry and roster.
- **Optional AI moderation** via Workers AI (off by default).
- **Optional Discord notifications**: per submission type, a rate-limited, best-effort webhook message (optionally into a thread) when a new submission is pending ([docs/SETUP.md](docs/SETUP.md) §5).

### How the wiki fits in

```
 wiki page (github.io)                         wiki-cms Worker (workers.dev)
 ┌──────────────────────────┐   <script>       ┌────────────────────────────────┐
 │ <div data-cms-type       │ ───────────────► │ /embed/v1.js + chunks (assets) │
 │      data-cms-group      │   GET list       │ /api/v1/*      public API      │
 │      data-cms-plugin>    │ ───────────────► │ /api/admin/*   moderators      │
 │ game plugin (team UI)    │ ◄─ import() ──── │ /api/internal/* CLI            │
 └──────────────────────────┘   admin loads    │ D1 (truth) · KV (published)    │
   /api/cms-groups.json   ◄──── registry ────  │ cron: housekeeping             │
   /assets/cms/<type>.js  ◄──── plugin  ─────  └────────────────────────────────┘
```

The generic UI is served from this repo. The wiki repo ships only the **plugin** (renders and edits the type-specific payload, e.g. a team formation) and a **groups registry** (`/api/cms-groups.json`, the list of valid groups and their options). See [`docs/CMS.md`](https://github.com/liveahero-wiki/liveahero-wiki.github.io/blob/master/docs/CMS.md) in the wiki repo for the wiki side.

## Stack

Hono · Cloudflare Workers, D1 (Drizzle ORM), KV, Static Assets, Workers Cache, Rate Limiting binding, Turnstile · BetterAuth · Valibot · markdown-it · Preact + Vite (admin and embed) · Vitest (`@cloudflare/vitest-pool-workers`) · pnpm.

## Repository layout

```text
wiki-cms/
├── src/
│   ├── index.ts            # Worker entry: fetch (Hono app) + scheduled (housekeeping)
│   ├── env.ts, config.ts   # bindings type; limits, retention, PUBLISH_REV
│   ├── core/               # generic: app, routes/{public,admin,internal}, auth, db, publish, groups, ...
│   ├── shared/             # code shared by Worker, embed and admin (no Worker-only APIs); plugin-api.ts is the plugin contract
│   └── types/              # submission type definitions (TYPE_DEFS); lah-team-formation/ is the only one
├── embed/                  # public embed (Vite): loader, list, form, i18n
├── admin/                  # admin SPA (Vite, Preact)
├── cli/                    # `cms` CLI (talks to D1 through wrangler)
├── migrations/             # drizzle-kit generated SQL for D1
├── public/_headers         # static asset headers (CORS, caching, admin CSP)
├── scripts/                # dev helpers and the post-deploy cache smoke test
├── test/                   # Worker tests (run inside workerd)
└── docs/                   # SETUP, EMBED, ADMIN, PLUGIN_API, ARCHITECTURE, TEAM_CREATOR
```

Vite builds both front ends into `dist/public/` (admin at the root, embed under `/embed/`); `wrangler.jsonc` serves that directory as Static Assets.

## Getting started

Requirements: Node 23.6+ (the CLI runs TypeScript directly), pnpm 12 (`packageManager` is pinned), a Cloudflare account for deploys.

```bash
pnpm install
pnpm db:migrate:local     # apply migrations to the local D1
pnpm build                # admin + embed -> dist/public
pnpm dev                  # wrangler dev on http://localhost:8787
```

Local secrets go in `.dev.vars` (gitignored): `BETTER_AUTH_SECRET`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `TURNSTILE_SECRET_KEY`, `TURNSTILE_SITE_KEY`, `CLI_TOKEN`, `PUBLIC_URL`. Use Cloudflare's [Turnstile test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/) locally.

Register the type against a locally running wiki (see the wiki repo's `docs/CMS.md` for its side) and create the first moderator invite:

```bash
node cli/cms.ts type add lah-team-formation --name "LAH team formation" \
  --origins http://localhost:8080 \
  --plugin-url http://localhost:8080/assets/cms/lah-team-formation.js \
  --groups-url http://localhost:8080/api/cms-groups.json
node cli/cms.ts invite create --types lah-team-formation
```

## Scripts

| Script | What it does |
|---|---|
| `pnpm dev` | `wrangler dev` (Worker + built assets) on :8787 |
| `pnpm dev:admin` / `pnpm dev:embed` | Vite dev server for the admin / rebuild the embed on change |
| `pnpm build` | Build admin and embed into `dist/public` |
| `pnpm deploy` | `pnpm build` then `wrangler deploy` |
| `pnpm test` | Vitest: `unit` (Node) and `worker` (workerd) projects |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm db:generate` | Generate a SQL migration from `src/core/db/schema.ts` |
| `pnpm db:migrate:local` / `db:migrate:remote` | Apply migrations to the local / production D1 |
| `pnpm cms ...` | The CLI (`--remote` targets production) |

## Deploying

See [`docs/SETUP.md`](docs/SETUP.md) for the full runbook (Discord app, Turnstile widget, secrets, remote migration, type registration, the Workers Cache smoke test, AI moderation). In short:

```bash
pnpm db:migrate:remote
pnpm deploy
node cli/cms.ts type add lah-team-formation --remote --name "LAH team formation" \
  --origins https://liveahero-wiki.github.io \
  --plugin-url https://liveahero-wiki.github.io/assets/cms/lah-team-formation.js \
  --groups-url https://liveahero-wiki.github.io/api/cms-groups.json
node cli/cms.ts invite create --types lah-team-formation --remote
```

The groups registry and plugin must already be published on <https://liveahero-wiki.github.io> (deployed from the wiki repo) before the embeds on the wiki work.

## Documentation

| Doc | Topic |
|---|---|
| [`docs/SETUP.md`](docs/SETUP.md) | Prerequisites, local dev, deploy, operations, cache smoke test, AI moderation |
| [`docs/EMBED.md`](docs/EMBED.md) | Host markup, lazy loading, HTTP caching, UI language (`cms:lang`), theming |
| [`docs/PLUGIN_API.md`](docs/PLUGIN_API.md) | Plugin contract (v1) that a wiki implements for its submission type |
| [`docs/ADMIN.md`](docs/ADMIN.md) | Admin portal development, plugin loading and the dev override |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Design rationale: free-tier budget, Workers Cache facts, submit pipeline, auth model, product decisions |
| [`docs/TEAM_CREATOR.md`](docs/TEAM_CREATOR.md) | LAH Team Creator: decisions, wiki contracts, team rules, data migration, rollout |

Wiki side: [`docs/CMS.md`](https://github.com/liveahero-wiki/liveahero-wiki.github.io/blob/master/docs/CMS.md) in [liveahero-wiki.github.io](https://github.com/liveahero-wiki/liveahero-wiki.github.io).

## Adding a submission type (another game or content kind)

1. Add `src/types/<type-id>/` exporting a `SubmissionTypeDef` (tags, explanation template, demo-URL policy, `validatePayload`, ...) and register it in `src/types/index.ts`. Keep the validator pure and unit tested.
2. Build a plugin in the consuming wiki that default-exports a `SubmissionPlugin` (see `docs/PLUGIN_API.md`) and publish a groups registry JSON.
3. `cms type add <type-id> ...` with the wiki's exact origin, plugin URL and groups URL.

## License

MIT
