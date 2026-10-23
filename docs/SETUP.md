# wiki-cms — Setup & operations

This Worker serves the public embed, the public API, the admin portal and the hourly housekeeping cron.
Everything runs on the Cloudflare **free tier**.

## 0. One-time prerequisites (human steps)

1. `wrangler login` (wrangler ≥ 4.69 is required for `cache.enabled`; the repo pins a newer one as a dev dependency).
2. Resources (already created for this project; IDs are in `wrangler.jsonc`):
   - `wrangler d1 create wiki_cms_db`
   - `wrangler kv namespace create KV`
3. **Discord application** (Developer Portal → OAuth2): redirects
   - `https://wiki-cms.rongjie.workers.dev/api/auth/callback/discord`
   - `http://localhost:8787/api/auth/callback/discord` (local dev)

   The Worker only requests the `identify` scope (never `email`).
3a. **Google OAuth client** (optional; unset = Google is not offered). Google Cloud Console → APIs & Services:
   - OAuth consent screen: user type External, publishing status **In production** (a "Testing" app limits sign-in to listed test users). Only the non-sensitive `openid` and `profile` scopes are used, so no Google verification is needed.
   - Credentials → OAuth client ID → Web application, authorized redirect URIs:
     - `https://wiki-cms.rongjie.workers.dev/api/auth/callback/google`
     - `http://localhost:8787/api/auth/callback/google` (local dev)

   Google is for contributors only; moderators still sign in with Discord. Contributors who sign in with Google skip the 30-day account-age gate (Google exposes no creation date) and are asked for a display name on their first sign-in.
4. **Turnstile widget** (Managed) with hostnames `liveahero-wiki.github.io` and `localhost`. The site key is a public var in `wrangler.jsonc` (`TURNSTILE_SITE_KEY`); the secret is a Worker secret.
5. Secrets (never commit them):

   ```bash
   pnpm exec wrangler secret put BETTER_AUTH_SECRET     # e.g. `openssl rand -base64 32`
   pnpm exec wrangler secret put DISCORD_CLIENT_ID
   pnpm exec wrangler secret put DISCORD_CLIENT_SECRET
   pnpm exec wrangler secret put GOOGLE_CLIENT_ID       # optional, see 3a
   pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET   # optional, see 3a
   pnpm exec wrangler secret put TURNSTILE_SECRET_KEY
   pnpm exec wrangler secret put CLI_TOKEN              # bearer token for `cms republish`
   ```

6. Local secrets live in `.dev.vars` (gitignored). Use Cloudflare's Turnstile **test keys** locally
   (site `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA`) and a random `BETTER_AUTH_SECRET`.

## 1. Local development

```bash
pnpm install
pnpm db:migrate:local          # applies migrations/ to the local D1
pnpm build                     # admin → dist/public, embed → dist/public/embed
pnpm dev                       # wrangler dev on http://localhost:8787
```

- `pnpm dev:admin` runs Vite for the admin on :5173 (proxying `/api` to :8787; mutations need the real :8787 origin because of the CSRF Origin check).
- `pnpm dev:embed` rebuilds the embed on change.
- `pnpm test` runs both Vitest projects (`unit` in Node, `worker` inside the Workers runtime).
- `pnpm typecheck` runs `tsc --noEmit`.

### Registering a type locally

```bash
node cli/cms.ts type add lah-team-formation --name "LAH team formation" \
  --origins http://localhost:8080,https://liveahero-wiki.github.io \
  --plugin-url http://localhost:8080/assets/cms/lah-team-formation.js \
  --groups-url http://localhost:8080/api/cms-groups.json
node cli/cms.ts invite create --types lah-team-formation      # prints the bootstrap invite link
```

Open the link, sign in with Discord, and you are the first moderator.

To require contributor accounts for submissions (the Team Creator does), set `cms type update lah-team-formation --submit-auth account` (add `--remote` for production). Do this **after** the wiki and embed that use the sign-in popup are live; until then the old anonymous form would get 401. Contributor sign-in uses the same Discord application as moderators (no new secrets); a Discord account must be 30 days old to become a contributor. `cms submission set-owner <submissionId> --user <contributorUserId|none>` (or the admin portal) assigns an owner to a legacy anonymous submission. Add `--remote` to every command to act on the production database.

## 2. Deploying

```bash
pnpm db:migrate:remote          # apply migrations to the production D1
pnpm deploy                     # build + wrangler deploy
node cli/cms.ts type add lah-team-formation --remote \
  --name "LAH team formation" \
  --origins https://liveahero-wiki.github.io \
  --plugin-url https://liveahero-wiki.github.io/assets/cms/lah-team-formation.js \
  --groups-url https://liveahero-wiki.github.io/api/cms-groups.json
node cli/cms.ts invite create --types lah-team-formation --remote
```

Production origins must be exact (scheme + host, no trailing slash). Add a second origin (e.g. a staging wiki) by
`cms type update <id> --origins a,b --remote` followed by `cms republish --type <id> --url <PUBLIC_URL>` (clears the cached config).

### Content-Security-Policy of the admin

`public/_headers` lists `https://liveahero-wiki.github.io` as the only external script origin (the admin loads the game
plugin from the wiki) and, for `connect-src`, also `https://api.github.com` (the page-edit plugin fetches the base file's blob to draw the diff). If you add a type whose plugin is hosted elsewhere, add that origin to `script-src` and `connect-src` in `public/_headers`
(for local development against `http://localhost:8080` use the Vite dev server for the admin, or temporarily add the origin).

### Team Creator rollout (one-off)

The move from per-page groups to the single `all` group, with its four phases and the wiki-side steps, is described in [TEAM_CREATOR.md](TEAM_CREATOR.md#rollout-one-off). The Worker side, in order (each `--remote` step is a deploy step; nothing here runs without being asked):

1. The wiki must already publish a registry that contains `all` (with `options.targets`).
2. `pnpm db:migrate:remote` (adds the `title` column), then `pnpm deploy` (`PUBLISH_REV` 2: new blob shape, type def and embed).
3. Data migration, game-specific so it is **not** in `migrations/`: `pnpm exec wrangler d1 execute wiki_cms_db --local --file scripts/data/2026-10-team-creator.sql` first (try it on `node scripts/dev-seed.mjs --reset` data), then the same with `--remote`. It moves every `lah-team-formation` row to `all`, maps `rng` to `successRate` (`none`/`few` to `high`, `many` to `medium`, `impractical` to `low`), sets `teamType = manual`, turns the three SSS simulator group ids into `payload.target`, bumps `version`/`updated_at` (open edit dialogs get a conflict) and writes one `data.migrate` audit row. It is idempotent: **run it again after the wiki deploy** to sweep rows that arrived in an old group meanwhile.
4. `CLI_TOKEN=… node cli/cms.ts republish --type lah-team-formation --url <PUBLIC_URL>`, then `republish --all`.
5. Moderators add names to the legacy rows (admin: "Untitled only").

### Translation types (voice lines and bios)

The two translation types ([ARCHITECTURE.md](ARCHITECTURE.md#translation-types-lah-voice-tl-lah-bio-tl)) are registered like any type. Deploy order: Worker with the migration first, then these commands, then the wiki (rosters, editor, admin plugins), then the wiki's Action secrets (`CLI_TOKEN`, the Worker URL). `type add` has no `--submit-auth` flag, so set it afterwards (the code already forces account-only, this keeps D1 and the admin consistent). Drop `--remote` for a local database; locally use `http://localhost:8080` URLs like above.

```bash
for t in lah-voice-tl lah-bio-tl; do
  node cli/cms.ts type add $t --remote \
    --name "LAH $t" \
    --origins https://liveahero-wiki.github.io \
    --plugin-url https://liveahero-wiki.github.io/assets/cms/$t.js \
    --groups-url https://liveahero-wiki.github.io/api/cms-groups.json
  node cli/cms.ts type update $t --remote --submit-auth account
  node cli/cms.ts mod grant <moderatorUserId> --types $t --remote
done
```

The groups registry is the same one the team type uses (group `all` already exists there). The roster is fetched by the hourly cron, so the translatable-lines check starts up to an hour after the type is added (submissions are accepted meanwhile). The intake Action reads approved rows with `GET /api/internal/submissions/<type>` and reports back with `POST /api/internal/submissions/<type>/external`, both with `Authorization: Bearer $CLI_TOKEN`.

### Page edits (`lah-page-edit`) and the GitHub App

Approving a page edit opens a pull request on the wiki repo through a GitHub App ([ARCHITECTURE.md](ARCHITECTURE.md#page-edits-and-the-github-app) has the trust model). Nothing here is deployed or run by the code; these are human steps, in this order after the Worker with the new code is live.

**1. Register the type** (add `--remote` for production; locally use `http://localhost:8080` URLs). `type add` has no `--submit-auth` flag, so set it afterwards (the code already forces account-only; this keeps D1 and the admin consistent):

```bash
node cli/cms.ts type add lah-page-edit --remote \
  --name "LAH page edit" \
  --origins https://liveahero-wiki.github.io \
  --plugin-url https://liveahero-wiki.github.io/assets/cms/lah-page-edit.js \
  --groups-url https://liveahero-wiki.github.io/api/cms-groups.json
node cli/cms.ts type update lah-page-edit --remote --submit-auth account
node cli/cms.ts mod grant <moderatorUserId> --types lah-page-edit --remote
```

The groups registry is the wiki's existing one (group `all`; this type ignores its `options` and has no roster). The admin imports the plugin (`assets/cms/lah-page-edit.js`, which draws the diff) from the wiki and fetches the base file's blob from `https://api.github.com`, which is why `public/_headers` allows that host in `connect-src`.

**2. Create the GitHub App** (GitHub > Settings > Developer settings > GitHub Apps, owned by the user or org that owns the wiki repo):

- Repository permissions: **Contents: Read & write**, **Pull requests: Read & write**, **Metadata: Read-only**. Nothing else; in particular **no Workflows** permission, so GitHub rejects any push that touches `.github/workflows/`.
- Subscribe to the **Pull request** event. Webhook URL `<PUBLIC_URL>/api/webhooks/github`, content type `application/json`, and a random webhook secret (`openssl rand -base64 32`).
- "Where can this app be installed": only on this account. Install it **only** on `liveahero-wiki/liveahero-wiki.github.io` (not "all repositories").
- Generate a private key. GitHub downloads a PKCS#1 PEM (`BEGIN RSA PRIVATE KEY`), which WebCrypto cannot import; convert it: `openssl pkcs8 -topk8 -nocrypt -in app.pem -out app-pkcs8.pem`. Note the App ID and the installation id (the number at the end of the installation's settings URL).

**3. Worker configuration.** `GITHUB_REPO` (`liveahero-wiki/liveahero-wiki.github.io`) and `GITHUB_BASE_BRANCH` (`master`) are public vars in `wrangler.jsonc`; `GITHUB_PREVIEW_LABEL` is unset on purpose (set it to the wiki's preview label only if previews should start automatically; the guard has then already limited the content to text and safe Liquid). Secrets, with `wrangler secret put` (never into `.dev.vars`/`.prod.vars` copies, docs or logs):

```bash
pnpm exec wrangler secret put GITHUB_APP_ID
pnpm exec wrangler secret put GITHUB_APP_INSTALLATION_ID
pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET
pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY < app-pkcs8.pem   # PKCS#8 PEM; pasted with literal \n escapes also works
```

Locally these go into `.dev.vars` (gitignored). Until they are set, approving a page edit answers `500 github_not_configured` and the row stays pending.

**4. Ruleset on the base branch** (repository settings > Rules > Rulesets), before the first approval:

- Target `master`: require a pull request and the status checks `build-and-test` and `contrib-guard` (the wiki's CI; `contrib-guard` runs on PRs from `contrib/*`). **Do not put the App on the bypass list**; the maintainers merge by hand and nothing merges automatically.
- Optional second ruleset: restrict branch creation/updates by the App to `contrib/**`.
- Create the `community-edit` label (the Worker adds it to every PR; GitHub also creates it on first use).

**5. Check:** the webhook's "Recent deliveries" shows 200 for `ping`; approve a test edit in the admin and watch the PR appear; merge or close it and the contributor's "my submissions" shows `merged` / `closed`.

## 3. Operations

| Task | Command |
|---|---|
| Invite a moderator | Moderators create invite links in the admin UI (24 h, single use). Bootstrap: `cms invite create`. |
| List / grant / revoke moderators | `cms mod list`, `cms mod grant <userId> --types t`, `cms mod revoke <userId> [--types t]` |
| Block / unblock an IP (IPv6 → /64) | `cms ip block <ip> --reason "…"`, `cms ip unblock <ip>` |
| Refresh cached public data after a type/config change | `CLI_TOKEN=… node cli/cms.ts republish --type <t> --url <PUBLIC_URL>` |
| Purge everything (e.g. after bumping `PUBLISH_REV`) | `CLI_TOKEN=… node cli/cms.ts republish --all --url <PUBLIC_URL>` |
| Tail logs | `pnpm exec wrangler tail` |

The hourly cron (`17 * * * *`) deletes spam older than 14 days, audit rows older than 30 days, expired invites/sessions, orphan users, nulls raw IPs
older than 90 days (`IP_RETENTION_DAYS` in `src/config.ts`), and refreshes each type's groups registry and roster (writing KV only when changed).

## 4. Post-deploy smoke test (Workers Cache)

Workers Cache is a deploy-time feature and cannot be verified locally:

```bash
node scripts/smoke-cache.mjs https://wiki-cms.rongjie.workers.dev lah-team-formation all
```

It checks that the public list endpoint is served `HIT` on the second request, that `Cache-Tag`/`CDN-Cache-Control` behave as designed
(and recommends `s-maxage` if `CDN-Cache-Control` is ignored), and that `/api/admin/*` and non-GET routes are never cached.
After an approval (or `cms republish`) the next request should be a `MISS`/`REVALIDATED` followed by `HIT` again.
If caching does not work on `workers.dev`, the design still works: every request is a miss that costs one KV read.

Budget note: with Workers Cache enabled every request to the Worker origin (including static assets) counts toward the 100k requests/day free limit.
Embed chunks are `immutable` and `v1.js` is browser-cached for 5 minutes; re-check Cloudflare's pricing page if traffic grows.

## 5. Optional: Discord notifications for new submissions

Each submission type can post a short message to a Discord webhook (optionally into a thread) whenever a new submission is waiting for review,
so moderators don't have to keep refreshing the queue. The message contains only the type, group title, pending count and a link to
`<PUBLIC_URL>/t/<type>/g/<group>`; it never contains user-submitted text and cannot ping anyone.

```bash
node cli/cms.ts type update lah-team-formation --remote \
  --discord-webhook https://discord.com/api/webhooks/<id>/<token> \
  --discord-thread <thread-id> \
  --webhook-per-hour 10           # default 10
node cli/cms.ts type update lah-team-formation --remote --discord-webhook none   # turn it off
```

- The webhook URL is a secret (anyone holding it can post to the channel). It is stored in D1 on the type row, is never returned by any API, is not
  printed by `cms type list` (which only shows `discord_webhook`: 0/1) and is not written to the audit log (only the column name is).
- Best-effort: sent from `ctx.waitUntil` after the submission is stored; failures and timeouts (3 s) are ignored. Once `--webhook-per-hour` messages
  have been sent in the current one-hour window (counted in D1, no KV writes) further notifications are dropped until the window ends.
- Config changes can take up to 60 s to be picked up (per-isolate type cache).

## 6. Optional: AI moderation (Workers AI, free tier ≈ 10k neurons/day)

Off by default. To enable, add `"ai": { "binding": "AI" }` to `wrangler.jsonc` (note: `wrangler dev` then talks to the remote AI service and
needs `wrangler login`) and set the `AI_MODERATION` var:

- `flag` — every new submission is classified once (`ai_verdict` = ok / spam / abusive / error) and the admin shows a badge; nothing else changes.
- `auto` — spam/abusive verdicts also move the pending submission to the **spam** state (audit `system.ai_spam`); moderators can restore it.

Any AI error only records `ai_verdict = 'error'`; it never blocks or fails a submission. The model is `AI_MODEL` in `src/core/ai-moderation.ts`.
