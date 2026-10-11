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
4. **Turnstile widget** (Managed) with hostnames `liveahero-wiki.github.io` and `localhost`. The site key is a public var in `wrangler.jsonc` (`TURNSTILE_SITE_KEY`); the secret is a Worker secret.
5. Secrets (never commit them):

   ```bash
   pnpm exec wrangler secret put BETTER_AUTH_SECRET     # e.g. `openssl rand -base64 32`
   pnpm exec wrangler secret put DISCORD_CLIENT_ID
   pnpm exec wrangler secret put DISCORD_CLIENT_SECRET
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

Open the link, sign in with Discord, and you are the first moderator. Add `--remote` to every command to act on the production database.

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

`public/_headers` lists `https://liveahero-wiki.github.io` as the only external script/connect origin, because the admin loads the game
plugin from the wiki. If you add a type whose plugin is hosted elsewhere, add that origin to `script-src` and `connect-src` in `public/_headers`
(for local development against `http://localhost:8080` use the Vite dev server for the admin, or temporarily add the origin).

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
node scripts/smoke-cache.mjs https://wiki-cms.rongjie.workers.dev lah-team-formation quest-1272003
```

It checks that the public list endpoint is served `HIT` on the second request, that `Cache-Tag`/`CDN-Cache-Control` behave as designed
(and recommends `s-maxage` if `CDN-Cache-Control` is ignored), and that `/api/admin/*` and non-GET routes are never cached.
After an approval (or `cms republish`) the next request should be a `MISS`/`REVALIDATED` followed by `HIT` again.
If caching does not work on `workers.dev`, the design still works: every request is a miss that costs one KV read.

Budget note: with Workers Cache enabled every request to the Worker origin (including static assets) counts toward the 100k requests/day free limit.
Embed chunks are `immutable` and `v1.js` is browser-cached for 5 minutes; re-check Cloudflare's pricing page if traffic grows.

## 5. Optional: AI moderation (Workers AI, free tier ≈ 10k neurons/day)

Off by default. To enable, add `"ai": { "binding": "AI" }` to `wrangler.jsonc` (note: `wrangler dev` then talks to the remote AI service and
needs `wrangler login`) and set the `AI_MODERATION` var:

- `flag` — every new submission is classified once (`ai_verdict` = ok / spam / abusive / error) and the admin shows a badge; nothing else changes.
- `auto` — spam/abusive verdicts also move the pending submission to the **spam** state (audit `system.ai_spam`); moderators can restore it.

Any AI error only records `ai_verdict = 'error'`; it never blocks or fails a submission. The model is `AI_MODEL` in `src/core/ai-moderation.ts`.
