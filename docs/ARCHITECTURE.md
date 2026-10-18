# Architecture and design decisions

What the code cannot tell you: why it is shaped this way, the platform facts it relies on, and the product decisions behind it. For *how* something works, read the code; for operations see [SETUP.md](SETUP.md). The LAH-specific decisions (Team Creator, team rules) are in [TEAM_CREATOR.md](TEAM_CREATOR.md).

## Who owns what

| Layer | Generic (reusable for another wiki) | Game-specific (LAH) |
|---|---|---|
| Worker | everything under `src/core/` | `src/types/lah-team-formation/` (validator, tags, explanation templates, limits), registered in `src/types/index.ts` |
| Embed + admin UI | all of it | none: game UI comes from the plugin |
| Per-type config (D1, via CLI) | `submission_type_tab` row: allowed origins, plugin URL, groups registry URL, enabled, Discord webhook | the values |
| Wiki repo | none | plugin, roster JSON, groups registry JSON, page markup |

One deployment can host several submission types, even for different wikis, because every type carries its own origins, plugin URL and registry URL. A type definition in code with no enabled D1 row is ignored (and the reverse), so a deploy and a `cms type add` can happen in either order.

Adding another game needs a new `src/types/<type>/`, a `submission_type_tab` row, a plugin module and a groups registry on that wiki, with **no core changes**. If you find yourself adding game logic to `core/`, `shared/`, `embed/` or `admin/`, stop: it belongs in the type def or the plugin.

## Free-tier budget

Everything must fit the Cloudflare free tier. Numbers are what was known when the system was designed; re-check Cloudflare's pricing and limits pages when traffic grows.

| Resource | Free limit | How we stay inside |
|---|---|---|
| Worker requests | 100k/day, 10 ms CPU each | Mostly Workers Cache hits (no CPU). `v1.js` is browser-cached 5 min, chunks are immutable. Embeds only load once scrolled near the viewport. |
| Static Assets | normally free | **Counted as requests once Workers Cache is enabled**: assume every request to the Worker origin counts toward the 100k/day. |
| KV | 100k reads, **1k writes**/day | Reads only on a Workers Cache miss. Writes only on publish (moderation actions) and when the registry changed. Never write KV on a read path (the one exception, filling a missing blob, ignores failures). |
| D1 | 5M rows read, 100k rows written/day | Source of truth, tiny. |
| Cron Triggers | 5 per account | Exactly **one** hourly trigger runs all housekeeping. Do not add more. |
| Workers AI (optional) | 10k neurons/day | At most one classification per submission, short output. |
| Turnstile, Rate Limiting binding | free | Form only / submit endpoint only. |

10 ms CPU means never rendering many markdown documents in one request: markdown is rendered once at insert/edit time and stored as `explanation_html`.

## Read path and Workers Cache

```
browser ─► Workers Cache (in front of the Worker) ─hit─► response, no Worker CPU
                          └─miss─► Worker ─► KV blob per (type, group) ─miss─► D1
```

- Workers Cache (`"cache": { "enabled": true }`, needs wrangler >= 4.69.0) is tied to the Worker, not a zone, and **works on `*.workers.dev`**. Do **not** use the old Cache API (`caches.default`): it is a separate store and a no-op on workers.dev.
- Only `GET`/`HEAD` are cached. The cache key is entrypoint + path + **query string**; the host is not part of it, and there is no purge by host. So the public client must always call the canonical list URL without parameters (any `?x=1` just creates another entry). The list route ignores the query string.
- Controls used: `Cache-Control`, `CDN-Cache-Control` (edge TTL), `Cache-Tag` (printable ASCII, no spaces or commas, invalid tags are silently dropped, so tags are built only from validated type/group ids) and `ctx.cache.purge({ tags })`. Purge is scoped to this Worker (a zone purge does nothing here) and always uses Free-tier purge rate limits. Pre-warming does not exist: a response is cached only after it was served once.
- The list response sets both `CDN-Cache-Control: max-age=86400` and `s-maxage=86400` inside `Cache-Control`, because it was never confirmed that `CDN-Cache-Control` alone is honored. The 24 h edge TTL is safe because every moderation action purges the tag; the browser TTL (5 min, stale-while-revalidate 1 h) cannot be purged, so that is how long a moderator change can take to reach a visitor.
- A hit is still billed as a Worker request, just with no CPU.
- **KV stays as the miss-path store.** It keeps the Worker correct if Workers Cache is unavailable, and it keeps a global purge from becoming a D1 query storm (a miss costs one KV read). If caching turned out not to work on workers.dev the design still works, only the budget changes: roughly one KV read per list view.
- Workers Cache is a deploy-time feature and cannot be exercised in `wrangler dev` or `vitest-pool-workers`. Do not mock hit/miss behaviour: unit tests assert the headers/tags and that `republish` purges the right tag (via an injected purger); real caching is verified by `scripts/smoke-cache.mjs` after a deploy (SETUP.md §4).
- Unverified on the production account when written, so check them if the budget looks tight: whether cache hits count against the 100k/day Free quota, and the Free plan's purge rate limit.

| Endpoint | Cache-Tag | Edge TTL | Purged by |
|---|---|---|---|
| `GET /api/v1/submissions/:type/:group` | `pub:<type>:<group>` | 24 h | `republish` on approve / edit / state change / group move / registry options change |
| `GET /api/v1/types/:type` | `cfg:<type>` | 1 h | `cms republish --type` (after `cms type update`) |
| unknown group (list) | none | 60 s, no `CDN-Cache-Control` | n/a (typos are not cached for long, and a newly opted-in page starts working within a minute of the registry refresh) |
| `/embed/*`, admin SPA (Static Assets) | none | per `public/_headers` | deploy (hashed assets; `v1.js` 5 min) |
| everything else | none | `Cache-Control: private, no-store` | n/a |

`app.ts` sets `private, no-store` on every response that has no explicit `Cache-Control`. Workers Cache only caches GET/HEAD, but never rely on the method alone for anything carrying cookies or admin data.

## Publishing

`republish(type, group)` writes the KV blob first and purges the cache tag second, so the refill after a purge always reads the new blob. A failed purge **never rolls back** the moderation action: the admin response says "published, but cache purge failed" and the audit detail records it; the 24 h edge TTL is then the only bound. KV puts carry a 90 day `expirationTtl` so orphaned keys vanish.

The KV key contains `PUBLISH_REV` (`src/config.ts`). Bump it when the blob shape or the tag/lang labels change. Old keys then expire from disuse, but the Workers Cache copies are still old-shaped, so also purge everything (`cms republish --all`). Because the wiki reads the blob directly, a shape change must be additive or ship to the wiki first ([TEAM_CREATOR.md](TEAM_CREATOR.md#the-blob-is-a-contract-with-the-wiki)).

## Submit pipeline

`POST /api/v1/submissions/:type/:group` runs its checks cheap-to-expensive; read `routes/public.ts` for the list. Reasons that are not obvious from the code:

- Turnstile is **last of the checks that can fail on user input**, because tokens are single-use and a user must not have to redo the captcha after fixing a validation error.
- A filled honeypot gets a fake `202 { id, state: 'pending' }` and nothing is stored, so bots learn nothing.
- Validation returns **all** field errors at once, each with a stable `code` (+ `params`) so clients localize them; the English `message` is the fallback.
- The group is looked up in the registry before validation, because group `options` drive type-specific rules.
- Per-IP limits use `ip_key` (IPv4 as is, IPv6 truncated to its /64) so a single IPv6 user cannot rotate addresses.
- AI moderation and the Discord notification run in `waitUntil` and can never block or fail a submission.

## Groups registry

The wiki publishes the list of valid groups and their `options` as JSON (`groups_url` on the type). The core treats group ids and `options` as opaque (format check only). It is read from KV, never from the wiki per request:

- KV `groups:<type>` holds the last copy; a 5 minute per-isolate memo sits in front of it.
- The hourly cron refetches every enabled type and writes KV **only if the content hash changed**. When a group's `options` changed it republishes that group, because the list blob embeds `groupOptions`.
- A list/submit for an unknown group refetches once (throttled, only if the cached copy is older than 10 minutes) before giving up, so newly opted-in pages work without waiting for the cron.
- The roster (`roster:<type>`, URL from the type def, not D1) works the same way and feeds a **soft** existence check: it rejects only when the roster was fetched successfully.
- Group ids are stable keys. If a group disappears from the registry its submissions stay in D1; listing returns an empty blob and a moderator can move them to another group.

## Moderators and auth

- Moderators sign in with Discord through BetterAuth, requesting the **`identify` scope only**. BetterAuth's user table requires an email, so a synthetic `discord-<id>@users.invalid` is stored and never displayed.
- Anyone with a Discord account can create a `user` row by signing in; that grants nothing, because authorization is the `moderator_permission_tab` rows (per submission type). Housekeeping deletes users with no permission, no claimed invite, no contributor profile and no submissions after 24 h.
- Permissions are re-read on every admin request, so revocation is immediate.
- Invite links: the token is only ever in the link (SHA-256 hash stored), 24 h, single use, claimed atomically. At claim time the inviter must **still** hold every type, and only the intersection is granted. Moderators cannot invite for types they lack. Revoking a moderator is CLI-only.
- Mutating admin routes require a JSON content type and `Origin === PUBLIC_URL` (CSRF). `/api/internal/*` takes a bearer `CLI_TOKEN` and never a session.
- Every moderator or CLI action writes an audit row; housekeeping writes one summary row, only when it deleted something.
- Admin CSP lives in `public/_headers` and lists the wiki origin as the only external script/connect source (the admin imports the plugin from `plugin_url`).

## Contributor accounts

Sign-in for submitters (and, later, other contributors) is separate from moderator auth. The wiki is on `github.io` and the Worker on `workers.dev`, both on the Public Suffix List, so the Worker cookie never reaches wiki pages. The session is therefore handed over explicitly:

- The wiki page opens a **popup** at `/api/contrib/auth/start` (Worker-rendered HTML; only `/api/*` runs worker-first, so it cannot live under `/contrib/*`). It starts the BetterAuth social sign-in; the callback is `/api/contrib/auth/done`, which mints an **opaque bearer token** and `postMessage`s it to `window.opener` with the wiki origin as `targetOrigin` (never `*`; the origin must be in some enabled type's `allowed_origins`).
- Tokens are 32 random bytes with a `cct_` prefix; only the SHA-256 is stored (`contrib_token_tab`, 30 days, deleted on sign-out and by housekeeping). They are **not** BetterAuth sessions and BetterAuth's `bearer` plugin is deliberately not used: `/api/admin/*` only reads the cookie session, so a token leaked from a wiki page has contributor power only. `/api/contrib/*` accepts only `Authorization: Bearer`, ignores cookies (no CSRF surface) and has CORS for allowed wiki origins without credentials.
- **Account-age gate:** when a user first becomes a contributor the provider account must be at least `CONTRIB_MIN_ACCOUNT_AGE_DAYS` (30) old (Discord: from the snowflake id; unknown age fails closed). Enforced in `/auth/done`, not in BetterAuth hooks, so moderator invites are unaffected. A too-young sign-in leaves no contributor row and the fresh `user` row is removed.
- Providers are a registry (`src/core/providers.ts`: id, label, configured, `accountCreatedAt`). Only Discord is wired; Reddit/X/GitHub = a registry entry, a `socialProviders` entry in `auth.ts` and secrets. Account linking across providers is not implemented.
- `contributor_tab` holds the display name (editable, shown to moderators) and a reserved `trust_level`. A type with `submit_auth = 'account'` (`cms type update <id> --submit-auth account`) refuses anonymous POSTs with 401 `account_required`.
- **Editing:** a contributor can edit only their own submission (`submission_tab.user_id`; legacy anonymous rows have none until a moderator assigns an owner). A never-published row is updated in place; a published row gets a **pending revision** (`submission_revision_tab`, at most one open per submission) and the published version stays live until a moderator approves it (approve copies the fields over, keeps `original`, republishes). The public blob never exposes owner or revision data. Creates/edits go through the same checks as anonymous submits (Origin, honeypot, IP block, rate limiter, Turnstile, caps) plus a per-contributor daily cap.

## Localization

- Public UI languages: `en`, `zh-Hans`, `zh-Hant`, `ja`. Scope: the embed list and form, plugin views, disclaimer, tag labels, field errors, explanation templates, the Turnstile widget language. Not localized: the admin portal (moderators only, English) and submitted content.
- Strings live in `embed/src/i18n/<lang>.ts` (generic), in the type def as `I18nText`/per-language maps (tags, templates, disclaimer), and in the plugin's own bundles (editor/detail labels, payload error codes). A missing key falls back to English, and a test per bundle set keeps the keys in sync.
- Game terminology (P.Lv, engravement, bloom, skill tree, fans, support, sidekick) must come from the wiki's official localized terms, not machine translation.
- English is the encouraged default for explanations: the form defaults the explanation language to `en` with a hint, but never forces it, and the list shows every language. The content language is independent of the UI language and is stored as `lang`. Admin-side AI translation is a possible future feature; nothing in the schema blocks it (for example a translation table keyed by `(submission_id, lang)`).

## Product decisions and defaults

Decisions made with the owner; change them deliberately.

- Submitter accounts are opt-in per type (`submit_auth`). A signed-in submitter can edit their own submissions but not delete them; edits of published items are moderated (see Contributor accounts). Moderators can edit at any state (optimistic locking via `version`; the first edit keeps the user's original in `original`). Anonymous types stay anonymous.
- Moderators only screen for spam and abuse. They do **not** verify that a team works; the disclaimer on the list says so.
- Spam is deleted 14 days after it was marked (moving it out of spam resets the clock); audit rows after 30 days.
- Raw IPs are nulled after 90 days (`IP_RETENTION_DAYS`); `ip_key` and country stay. This is a privacy default the owner did not explicitly ask for, and one constant to change.
- Public input limits: 32 KB body, 10 submissions per `ip_key` per type per day, 10 creates+edits per contributor per type per day (`SUBMISSIONS_PER_USER_PER_DAY`), 500 pending per type (protects moderators from floods), 3 submissions per minute per `ip_key` (`SUBMIT_LIMITER`).
- Explanations: Markdown with no HTML or images and at most 3 validated inline links (see EMBED.md "Links in explanations"). Headings are remapped so community text never competes with the wiki's own `h2`.
- The Worker URL is `*.workers.dev` until the owner decides on a custom domain.
