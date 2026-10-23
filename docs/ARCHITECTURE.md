# Architecture and design decisions

What the code cannot tell you: why it is shaped this way, the platform facts it relies on, and the product decisions behind it. For *how* something works, read the code; for operations see [SETUP.md](SETUP.md). The LAH-specific decisions (Team Creator, team rules) are in [TEAM_CREATOR.md](TEAM_CREATOR.md).

## Who owns what

| Layer | Generic (reusable for another wiki) | Game-specific (LAH) |
|---|---|---|
| Worker | everything under `src/core/` | `src/types/lah-team-formation/` (validator, tags, explanation templates, limits), `src/types/lah-voice-tl/` and `lah-bio-tl/` (translation suggestions), registered in `src/types/index.ts` |
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
- Admin CSP lives in `public/_headers` and lists the wiki origin as the only external script source (the admin imports the plugin from `plugin_url`) and, for `connect-src`, also `https://api.github.com` (the page-edit plugin reads the base file's blob).

## Contributor accounts

Sign-in for submitters (and, later, other contributors) is separate from moderator auth. The wiki is on `github.io` and the Worker on `workers.dev`, both on the Public Suffix List, so the Worker cookie never reaches wiki pages. The session is therefore handed over explicitly:

- The wiki page opens a **popup** at `/api/contrib/auth/start` (Worker-rendered HTML; only `/api/*` runs worker-first, so it cannot live under `/contrib/*`). It starts the BetterAuth social sign-in; the callback is `/api/contrib/auth/done`, which mints an **opaque bearer token** and `postMessage`s it to `window.opener` with the wiki origin as `targetOrigin` (never `*`; the origin must be in some enabled type's `allowed_origins`).
- Tokens are 32 random bytes with a `cct_` prefix; only the SHA-256 is stored (`contrib_token_tab`, 30 days, deleted on sign-out and by housekeeping). They are **not** BetterAuth sessions and BetterAuth's `bearer` plugin is deliberately not used: `/api/admin/*` only reads the cookie session, so a token leaked from a wiki page has contributor power only. `/api/contrib/*` accepts only `Authorization: Bearer`, ignores cookies (no CSRF surface) and has CORS for allowed wiki origins without credentials.
- **Account-age gate:** when a user first becomes a contributor the provider account must be at least `CONTRIB_MIN_ACCOUNT_AGE_DAYS` (30) old (Discord: from the snowflake id; unknown age fails closed). Providers with `ageGate: false` skip it: Google exposes no creation date, so it relies on moderation, Turnstile and the per-user, per-IP and pending caps. Enforced in `/auth/done`, not in BetterAuth hooks, so moderator invites are unaffected. A too-young sign-in leaves no contributor row and the fresh `user` row is removed.
- Providers are a registry (`src/core/providers.ts`: id, label, configured, `ageGate`, `accountCreatedAt`, `promptDisplayName`). Discord and Google are wired (Google only when `GOOGLE_CLIENT_ID/SECRET` are set; scopes `openid profile`, synthetic `google-<sub>@users.invalid` email, never the email scope); Reddit/X/GitHub = a registry entry, a `socialProviders` entry in `auth.ts` and secrets. Google is offered to contributors only, never to moderators. Account linking across providers is not implemented: signing in with both gives two contributors.
- **Display name:** a provider with `promptDisplayName` (Google, whose profile name is usually a real one) does not supply it. A new contributor from such a provider is created as "Contributor" and the popup message carries `needsDisplayName: true`; the embed then shows a name dialog (`PATCH /me`). Closing it keeps "Contributor", and the embed asks again each time the submission form opens until a name is saved.
- **Provider picker:** `cmsEmbed.contrib.signIn()` shows a picker (shadow DOM, buttons from `GET /auth/providers`, which has CORS for wiki origins) and opens the popup from the click on a provider. The provider id of the last successful sign-in is kept in the wiki's `localStorage` (`cms-contrib-provider:<api>`) and listed first and focused next time.
- **Sign-in popups and `window.opener`:** the popup hands its result to the wiki tab with `postMessage` to `window.opener`, **and** (when the tab sent a secret `r`) as a short-lived `verification_tab` row (`login-result:<sha256(r)>`, 5 minutes, single use, bound to the tab's origin) that the tab collects with `POST /auth/poll`. The second path exists because a provider's own pages can send `Cross-Origin-Opener-Policy` and sever that link, after which `popup.closed` reads true while the user is still signing in. Bluesky's did (the provider was removed on 2026-10-22; git history `7990a28`, `68a07fd`), and Google's sign-in pages send `same-origin`. The embed therefore polls for providers in `SEVERS_OPENER` (`contrib-session.ts`; `google`) and cannot watch their popup for closing: the wait ends after 10 minutes or when the user starts another sign-in. Discord does neither: no `r`, no polling, a closed popup is reported at once.
- `contributor_tab` holds the display name (editable, shown to moderators) and a reserved `trust_level`. A type with `submit_auth = 'account'` (`cms type update <id> --submit-auth account`) refuses anonymous POSTs with 401 `account_required`.
- **Editing:** a contributor can edit only their own submission (`submission_tab.user_id`; legacy anonymous rows have none until a moderator assigns an owner). A never-published row is updated in place; a published row gets a **pending revision** (`submission_revision_tab`, at most one open per submission) and the published version stays live until a moderator approves it (approve copies the fields over, keeps `original`, republishes). The public blob never exposes owner or revision data. Creates/edits go through the same checks as anonymous submits (Origin, honeypot, IP block, rate limiter, Turnstile, caps) plus a per-contributor daily cap.

## Type hooks and work done outside the Worker

A type is more than a team formation: the `SubmissionTypeDef` has optional switches so that other contributions (translation suggestions, page edits) reuse the whole pipeline (accounts, guards, moderation, audit) without core changes. All default to the old behaviour.

| Field | Effect |
|---|---|
| `explanation`, `demoUrl` omitted | no explanation/demo is asked or validated (stored as `''`); `GET /api/v1/types/:type` returns `null` for them; the admin hides those fields |
| `maxBodyBytes` | request body cap for this type's create/edit (default 32 KB, `MAX_BODY_BYTES`); `maxPayloadBytes` still bounds the payload |
| `accountOnly` | anonymous `POST /api/v1/...` is 401 `account_required` whatever `submit_auth` says in D1; the config reports `submitAuth: 'account'` |
| `editable: false` | the owner's `PUT /api/contrib/submissions/:id` is 403 `not_editable` (moderators can still `PATCH`) |
| `publicList: false` | `GET /api/v1/submissions/:type/:group` is 404 `not_public` and `republish` is a no-op, so approving never writes KV or purges |
| `onApprove(env, row, now)` | runs before a moderator's approval is saved (`POST /api/admin/submissions/:id/state`). `ok: true` approves and stores the returned `external`; `ok: false` keeps the row pending, stores the failure's `external` (so moderators and the owner see why) and answers with the hook's status/code. The version is not bumped, so the moderator just retries. Bulk approval is refused (`bulk_not_allowed`) for such types |

`submission_tab.external` (+ `external_at`) is a JSON object a type or the outside worker writes about a row **after approval**; the core only understands `outcome` (`{ status, url?, label? }`, https URLs only, bounded) and shows exactly that to the owner as `ContribSubmission.outcome`. Moderators see all of it in the admin card. Everything else in it is private to the type.

Work that cannot run in a Worker (writing a Google Sheet needs credentials the Worker never holds; opening a pull request has its own hook) is done by a job in the wiki repo through bearer-`CLI_TOKEN` endpoints:

- `GET /api/internal/submissions/:type?limit=` lists approved rows whose `external` is null, oldest approval first: `{ id, version, groupId, lang, payload, approvedAt, displayName }` (no IPs).
- `POST /api/internal/submissions/:type/external` with `{ results: [{ id, external }] }` stores the results and answers `{ stored, skipped }`. A row that is not approved or already has an `external` is **skipped**, so a repeated run cannot overwrite a result or a moderator's decision. Each stored batch writes one audit row.
- When a moderator `PATCH`es the **payload** of a row whose `external.outcome.status` is `conflict`, `external` is cleared: the row is listed again and the job retries with the corrected text.

## Translation types (`lah-voice-tl`, `lah-bio-tl`)

Contributors suggest English, Simplified Chinese or Traditional Chinese translations of voice lines (a batch per voice resource, at most 100 lines) and of one character bio. The payloads, roster formats and the wiki side (editor, intake Action, sheet columns) are in the wiki repo's `docs/CONTRIBUTOR_EDITING.md`; what matters here:

- Both are `accountOnly`, not `editable`, `publicList: false`, group `all`, `lang` `en`, `zh-Hans` or `zh-Hant` (one language per submission: `text` and `base` are in that language; `validateSubmission` passes it to the validators as `ctx.lang`), no title/tags/explanation/demo. The suggestion UI is the wiki's editor, not the embed form: it signs in with `window.cmsEmbed.contrib` and posts to `/api/contrib/submissions/<type>/all`.
- Payload text is **plain text** (no `<`, `>`, `{%`, `{{`, `{#`, control characters other than newline; at most 2000 characters, optional note at most 500), because it ends up in a Google Sheet and then in wiki HTML. `base` (the text the contributor saw) is kept as sent and is what the intake Action compares with the sheet to detect a conflict; a suggestion equal to `base` is rejected.
- A voice line may also carry `jp`, the Japanese transcription of a line the game has no Japanese text for (same plain-text rules). It is only accepted while the roster entry's `jp` is empty (`jp_not_allowed`), and with a `jp` the English `text` is optional.
- **Per-language roster rule.** A roster entry lists the languages still open for it in `langs` (`en`, `hans`, `hant`; the game's own text wins per language). A non-English submission needs the entry's `langs` to include its language (`line_not_translatable` / `bio_not_translatable`) and the entry to have a Japanese text (`jp_required`), and cannot carry `jp` (`jp_not_allowed`). An entry without `langs` (an older roster) offers every language.
- A roster (`rosterPath`, `/api/voice-roster.json` and `/api/bio-roster.json` next to the groups registry) lists what is translatable. The check is **soft** like the team roster: enforced only when the roster was fetched and is well-formed, so a missing roster never blocks submissions. The roster is read from KV, which the hourly cron fills, so a newly added type has no roster check for up to an hour.
- No public blob: approval changes only D1. The intake Action pulls approved rows from the internal API, writes the sheet and posts `{ outcome: { status: 'synced' | 'conflict' | 'superseded', label? }, written, conflicts }` back. The contributor sees the outcome in "my submissions"; a `conflict` stays visible to moderators until one fixes the line.

## Page edits and the GitHub App

`lah-page-edit` lets a signed-in contributor propose a new body for one wiki page (`_charas/*.md`, `_events/*.md`, `_main_quests/*.md`, `guide/*.md`, `chara_quests.md`, `mobs.md`). Payload: `{ path, baseSha, after, summary }`; `after` is the whole new body without front matter, `baseSha` the git blob sha the contributor started from. It is account-only, not editable by its owner, never listed publicly, and has its own 128 KB body cap. Nothing touches GitHub until a moderator approves.

On approval `onApprove` (`src/types/lah-page-edit/approve.ts`, using the generic client in `src/core/github-app.ts`) does, as the GitHub App:

1. Read the file on `GITHUB_BASE_BRANCH` (default `master`). Same blob sha as `baseSha`, or an identical body (only the front matter changed): continue. A different body is a **conflict**: `409 base_conflict`, the row stays pending and `external.outcome` = `conflict` (the moderator edits `after` and sets the new `baseSha`; saving the payload clears the conflict). No automatic merge.
2. Write the file as current front matter + `after` through the Git Data API (blob, tree, commit, ref) onto `contrib/<submission id>`, with the contributor as `Co-authored-by` (`contrib-<user id>@users.invalid`, a placeholder address that cannot receive mail), and open a PR labelled `community-edit`. The PR body contains no contributor-written text.
3. Store `external = { outcome: { status: 'pr_open', url, label }, pr: { number, branch, url } }`. Re-approving after a pending round trip fast-forwards the same branch (a commit with parents `[branch head, master head]`, so the PR diff stays this one file) and reuses the open PR instead of opening a second one; if the PR was closed a new one is opened from the same branch.

The GitHub App webhook (`POST /api/webhooks/github`, `X-Hub-Signature-256` HMAC with `GITHUB_WEBHOOK_SECRET`, constant-time) moves the outcome to `merged` / `closed` (and back to `pr_open` on reopen). It only acts on same-repository `contrib/<id>` branches whose PR number matches the stored `pr.number`, audits as actor `github`, and does not bump the submission `version`. Everything else gets a 200 and is ignored.

Trust model:

- The Worker **never merges** and never enables auto-merge; a maintainer reviews and merges every PR. It only adds `committer-approved` (the wiki's preview trigger) if `GITHUB_PREVIEW_LABEL` is set, which it is not by default.
- The App has `contents: write`, `pull_requests: write`, `metadata: read` and **no `workflows` permission**, so GitHub rejects any push that touches `.github/workflows/`. It is installed on the wiki repo only. A ruleset on the base branch requires a PR plus the `build-and-test` and `contrib-guard` checks and does not list the App as a bypass actor, so a leaked key can open junk PRs and push `contrib/*` branches but not change `master`.
- The Worker validates structure only (path whitelist, `baseSha`, size, no NUL, `after` must not start with a front matter fence, summary is one plain line). The Liquid/HTML guard is the wiki's `contrib-guard` CI job, which checks out the guard from the base branch; the Worker cannot import the wiki's code and a copy would drift.
- The installation token (1 h) is cached in KV for 50 minutes: about one KV write per hour of activity. A 401 from GitHub drops the cached token. Error messages (shown to moderators) carry the HTTP status and GitHub's message, never a token or key.
- Failures: unset configuration is `500 github_not_configured`, any GitHub error `502 github_error`; in both cases the submission stays pending and the moderator can retry.

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
- Public input limits: 32 KB body (a type may raise it with `maxBodyBytes`), 10 submissions per `ip_key` per type per day, 10 creates+edits per contributor per type per day (`SUBMISSIONS_PER_USER_PER_DAY`), 500 pending per type (protects moderators from floods), 3 submissions per minute per `ip_key` (`SUBMIT_LIMITER`).
- Explanations: Markdown with no HTML or images and at most 3 validated inline links (see EMBED.md "Links in explanations"). Headings are remapped so community text never competes with the wiki's own `h2`.
- The Worker URL is `*.workers.dev` until the owner decides on a custom domain.
