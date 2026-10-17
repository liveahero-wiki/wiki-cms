# wiki-cms — Agent Guide

Community-submissions CMS on a single Cloudflare Worker (free tier). Its only consumer today is the Live A Hero wiki: <https://github.com/liveahero-wiki/liveahero-wiki.github.io> (a separate repo, usually checked out as `lah-wiki`). Read [README.md](README.md) first for the overview and [docs/](docs/) for details.

## Commands

Use **pnpm** (pinned in `packageManager`).

```bash
pnpm install
pnpm test            # Vitest: `unit` (Node) + `worker` (workerd) projects
pnpm typecheck       # tsc --noEmit — run after every change
pnpm build           # admin + embed -> dist/public (required before `pnpm dev`/deploy)
pnpm dev             # wrangler dev on :8787
pnpm db:generate     # after editing src/core/db/schema.ts
pnpm db:migrate:local
```

Run `pnpm typecheck && pnpm test` before declaring work done. Front-end changes that are observable need a rebuild (`pnpm build:embed` / `pnpm build:admin`) and a real look in the browser; Browser pane visibility matters (a hidden pane stops `IntersectionObserver`, so the lazy embed does not load — import the list chunk manually to test).

## Architecture rules

- **Core is generic.** `src/core/**`, `src/shared/**`, `embed/**`, `admin/**` must not contain game-specific logic. Everything specific to a content kind lives in `src/types/<type-id>/` (a `SubmissionTypeDef`) and in the plugin hosted by the wiki. Group ids and `options` are opaque to the core.
- **Names and tags are generic.** A type opts into a per-item name (`SubmissionTypeDef.title`, stored in the `title` column, validated by `src/shared/title-policy.ts`) and into tag `default`s; the core never knows what a tag means. The public blob (`PublicBlob` / `PublicItem` / `TagDefDto` in `src/shared/api-types.ts`) is a contract with the wiki, which draws the Team Creator list itself and filters the one big group in the browser (see [docs/TEAM_CREATOR.md](docs/TEAM_CREATOR.md#the-blob-is-a-contract-with-the-wiki)). Target lists and similar per-group data are registry `options` owned by the wiki.
- **`src/shared/` is imported by Worker, embed and admin**: no Worker-only APIs (no `env`, `crypto.subtle` assumptions beyond what browsers have, no Node imports). `src/shared/plugin-api.ts` is the contract copied verbatim into the wiki repo — changing it is a breaking change for the plugin; bump `apiVersion` deliberately and update `docs/PLUGIN_API.md` and the wiki's copy.
- **Read path**: public `GET` → Workers Cache (`"cache": {"enabled": true}`, `Cache-Control` / `CDN-Cache-Control`, `Cache-Tag`, `ctx.cache.purge`) → on a miss, a KV blob per `(type, group)` built by `src/core/publish.ts`. D1 is the source of truth; KV is written only when content is published (moderation actions, registry refresh). Do **not** use `caches.default` (a no-op on `workers.dev`). If you change the published blob shape or tag/lang labels, bump `PUBLISH_REV` in `src/config.ts` and purge everything (`cms republish --all`).
- **CPU budget is 10 ms/request.** Render markdown once at insert/edit time and store `explanation_html`; never render many documents per request.
- **Free tier only.** Every request to the Worker origin (including static assets, because Workers Cache is on) counts toward 100k requests/day. Exactly one cron trigger is used (hourly housekeeping); do not add more. KV writes are limited to 1k/day — never write KV on a read path.
- **Public input is hostile.** All submissions go through Valibot validation, the markdown policy (`src/shared/markdown-policy.ts` + `link-policy.ts`: no HTML or images; only inline `[text](https://…)` links, max 3, no shorteners/IP hosts/punycode, link text must not impersonate another site; rendered as `<a class="cms-ext">` with the real host inside the link, `rel="noopener noreferrer nofollow ugc"`; moderators see every full URL in the admin card), demo-URL allowlist (`src/core/demo-url.ts`), Turnstile, `SUBMIT_LIMITER`, per-IP daily cap, IP blocklist and the pending-queue cap. Keep these in place when touching `routes/public.ts`.
- **Discord webhook** (`src/core/discord-notify.ts`): the per-type webhook URL in D1 is a secret — never return it from an API, log it, or write it to the audit log/docs/tests (use fake URLs). Notifications are best-effort via `waitUntil`, rate limited by a D1 counter on the type row (not KV), and contain metadata only, never user-supplied text.
- **Admin portal is English-only; the public UI is localized** (`en`, `zh-Hans`, `zh-Hant`, `ja`, files in `embed/src/i18n/`, with a test that keeps the bundles in sync). Add a key to all four when you add UI text. English is the encouraged default for submission explanations.
- **Moderator auth**: BetterAuth + Discord, `identify` scope only — never request `email`. Mutating admin routes are protected by an Origin (CSRF) check; permissions are per submission type (`authz.ts`). Every moderator action writes an audit row (`audit.ts`).
- **Plugin loading**: the embed imports the plugin from the wiki page's origin; the admin imports it from `plugin_url` stored in D1 for the type. If a new plugin host is introduced, update the admin CSP in `public/_headers` (`script-src` / `connect-src`).

## Conventions

- TypeScript, ESM (`"type": "module"`), strict. Relative imports include the `.ts` extension (`allowImportingTsExtensions`, and the CLI runs under Node type stripping — no enums, namespaces or parameter properties in `cli/` and anything it imports).
- Match the style of the surrounding code (no semicolons, single quotes, 2-space indent, trailing commas in multiline literals).
- Hono for routing; Drizzle for D1 access (table objects are named `*_tab`). Time is injected via `deps.now()` so tests can control it.
- Validators in `src/types/*/validate.ts` are pure and unit tested (`validate.test.ts` beside them). Pure front-end logic gets a plain Vitest unit test; anything that needs bindings goes under `test/` (workerd). Test helpers: `test/helpers.ts`, `test/setup.ts` (applies migrations).
- Never hand-edit files under `migrations/` or `migrations/meta/`; change `src/core/db/schema.ts` and run `pnpm db:generate`. Remote migration is a deploy step, not a dev step.

## Gotchas

- Vitest must stay on **4.x** for `@cloudflare/vitest-pool-workers` 0.22. The Worker test project uses `compatibilityDate: '2026-08-01'`; `wrangler.jsonc` must not exceed the compat date supported by the bundled workerd (currently `2026-09-25`).
- Workers Cache cannot be verified locally. After a deploy, run `node scripts/smoke-cache.mjs https://wiki-cms.rongjie.workers.dev <type> <group>` (see `docs/SETUP.md` §4).
- Tests can forge a BetterAuth session by signing the cookie `better-auth.session_token` with HMAC-SHA256 of `BETTER_AUTH_SECRET` (see `test/admin.test.ts`, `scripts/dev-login.mjs`).
- IPv6 `ip_key` is stored as `a:b:c:d::` (the /64 prefix, no `/64` suffix) so it can appear in URL paths.
- `cms` CLI talks to D1 through `wrangler d1 execute`; `--remote` hits production. `cms republish` needs `CLI_TOKEN` in the environment.
- Static cross-origin loading requires CORS headers on `/embed/*` (see `public/_headers`); keep them when changing the asset layout.

## Secrets and safety

- `.dev.vars` and `.prod.vars` hold real secrets and are gitignored. Never print, commit or copy them into docs, tests or logs. Production secrets are set with `wrangler secret put`; only public vars live in `wrangler.jsonc`.
- Treat the production Worker, D1 and KV (IDs in `wrangler.jsonc`) as shared infrastructure: do not run `--remote` commands, `wrangler deploy`, `db:migrate:remote` or `secret put` unless the user asks for it.
- Submissions contain user-supplied text and IP addresses (raw IPs are nulled after `IP_RETENTION_DAYS`). Don't log them in plain text or add new places that retain them.

## Working across the two repos

The wiki repo (`liveahero-wiki.github.io`, local folder `lah-wiki`) owns: the groups registry (`/api/cms-groups.json`, built by `wiki_plugins/lib/cms-groups.js`; one group `all` whose `options.targets` come from page front matter, see `docs/PLUGIN_API.md`), the game plugin (`web/cms-plugin/` -> `assets/cms/lah-team-formation.js`), the roster JSON, page markup and styling. This repo owns: the Worker, embed, admin, CLI and `src/types/lah-team-formation/validate.ts`. Changes that cross the boundary (payload shape, group `options`, `plugin-api.ts`) need both sides updated and the wiki deployed before the Worker change goes live. The wiki also owns the Team Creator list UI (`web/team-creator/` -> `assets/cms/team-creator.js`): it reads the public blob directly and opens the form via `window.cmsEmbed.openForm` (see `docs/TEAM_CREATOR.md`). `src/shared/api-types.ts` is therefore a second verbatim-copied contract (wiki: `web/cms-plugin/api-types.ts`): a `PUBLISH_REV` or blob shape change needs the wiki updated first, or must be additive. Wiki-side docs: `docs/CMS.md` in that repo; its own `AGENTS.md` applies when working there.

## References

- [docs/SETUP.md](docs/SETUP.md) — prerequisites, local dev, deploy, operations, cache smoke test, AI moderation
- [docs/EMBED.md](docs/EMBED.md) — host markup, lazy loading, caching, language hook, theming
- [docs/PLUGIN_API.md](docs/PLUGIN_API.md) — plugin contract
- [docs/ADMIN.md](docs/ADMIN.md) — admin portal development
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — why it is built this way: free-tier budget, Workers Cache facts, submit pipeline, auth model, product decisions
- [docs/TEAM_CREATOR.md](docs/TEAM_CREATOR.md) — the LAH Team Creator: single `all` group, titles/tags/targets, wiki-owned list UI, team rules, data migration, rollout
