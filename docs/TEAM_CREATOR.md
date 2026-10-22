# LAH Team Creator: decisions, contracts and rollout

The Live A Hero wiki lists **all** approved team formations on one page, `/team-creator.html`, from a single cached API response, and filters them in the browser. This page records why it is built that way, the contracts between this repo and the wiki repo (`liveahero-wiki.github.io`, local folder `lah-wiki`), and the one-off rollout. How things work is in the code; the wiki side is documented in that repo's `docs/CMS.md` (hash parameters, `team_formations:` front matter, registry, roster `limited`), which is the source of truth for it.

## Why a single page

Chara pages get a lot of traffic, most of it not looking for teams, and each visible embed costs Worker requests. Submissions were also scattered across per-card and per-quest groups although one team often fits several characters. So there is one group, `all`, and a team name plus filters instead of many lists.

## Decisions

| Decision | Why |
|---|---|
| **One group, `all`.** All rows live in it; the registry has only that group. | One canonical URL, one KV blob, one cache tag. No new endpoint or read path. |
| **Team name is a core field** (`title`), not part of the payload. | The core embed and admin show and search it on every card, and any future type can use one. The type def decides whether it exists, its label and its length (LAH: required, 4–50 characters, plain text, no URLs). |
| **Team type and success rate are tags.** `teamType`: `manual` (default) / `auto`; `successRate`: `high` / `medium` / `low`. | Fixed option sets: tag validation, the form's radio groups and the admin editor already exist. Tag `default`s are generic (the form preselects; the server never fills one in). |
| **`target` is an optional payload field**: a string id chosen by the wiki, not a quest id. The valid targets are the group's `options.targets`, owned by the wiki. | Targets are not always quests (Unexplored bosses have no `QuestMaster` entry). Adding or renaming one is a wiki-only change with no Worker deploy, because group `options` already reach both the validator and the plugin. See [PLUGIN_API.md](PLUGIN_API.md#type-specific-group-options-lah-targets). Only fights worth a structured target (the rotating SSS challenge simulators, later Unexplored bosses) get one; everything else goes in the name. |
| **Support is optional in `all`** (`options.support: 'optional'`). | `support: true` means *required*, and rows that came from no-support quests have none, so a general list cannot force one. |
| **The wiki draws the list; wiki-cms keeps the APIs and the form.** | Game-specific filters and cards are easier to build and change in one repo. The form stays here because it is tied to the API: Turnstile, markdown/title policies, server-error mapping, drafts and about 40 localized error strings. Validation changes then still ship in one Worker deploy. |
| **Chara/event pages only link to the Team Creator**, pre-filtered through the URL hash. | No Worker request at all on those pages. |

### Resolved questions

- The old `rng` tag maps to `successRate`: `none`/`few` → `high`, `many` → `medium`, `impractical` → `low` (implemented in the data-migration SQL).
- The borrowed support slot counts in every hero filter and in the limited-count sort, because a viewer may own the unit the submitter borrowed. (Wiki-side behaviour.)
- Parallel Quartz and hard-difficulty event rows moved to `all` without a target; moderators put the quest into the name while backfilling names.
- Existing rows have an empty `title`; the admin flags them ("Untitled", "Untitled only" filter) and requires a name before they can be edited.

### Wiki-owned UI conventions that constrain this repo

- The wiki's Team Creator app (`web/team-creator/` -> `assets/cms/team-creator.js`) loads `v1.js` **lazily** with `import()` on the first submit click (saves a Worker request per page view; a dynamic import of the same URL returns the same module instance) and calls `window.cmsEmbed.openForm`. API and rules: [EMBED.md](EMBED.md#opening-the-submit-form-from-your-own-ui).
- Its root element must not carry `data-cms-type` (the loader would take it over), and its own CSS classes use a different prefix (`lah-tc-*`), because opening the form injects the whole embed stylesheet and any `cms-*` name in the wiki list would be restyled at that moment. Only the form's dialog host carries `cms-submissions`.
- The wiki owns the disclaimer text for its page (so the page does not fetch the type config); `TypeConfig.disclaimer` stays here as a generic embed feature.
- The wiki-side hash keys (`q`, `sort`, `lang`, `t.<tag>`, `target`, `hero`, `xhero`, `sk`, `xsk`, `tree`, `bloom`, `lim`) are used by links on chara and event pages. Nothing in this repo parses them.

### The blob is a contract with the wiki

The wiki reads `GET /api/v1/submissions/lah-team-formation/all` directly, so `PublicBlob` / `PublicItem` / `TagDefDto` in `src/shared/api-types.ts` are a **second verbatim-copied contract** (wiki copy: `web/cms-plugin/api-types.ts`, like `plugin-api.ts`). Before this, only the embed read the blob and it deployed together with the Worker. Now any `PUBLISH_REV` or shape change needs the wiki updated first, or must be additive; and a tag option removed or renamed here breaks links and filters there.

### Considered and dropped

A generic `catalog` layout inside the core embed, with game filters supplied by an optional plugin `listFilter`, was built and then deleted before it ever deployed. Do not reintroduce a game-specific list in the core: the plain `list` layout stays as the generic embed for other wikis, and a wiki that wants a richer page draws its own from the blob (as above).

## Team rules (`src/types/lah-team-formation/validate.ts`)

The validator is authoritative and the plugin mirrors it for UX (the plugin's `validate()` must keep the same codes and params). Rules and decisions that the code does not explain:

- **Support is group-driven, not a team-level choice.** The group's `options.support` decides: `true`/absent = exactly one slot is the borrowed support (`supportIndex` required), `false` = none (an explicit non-null `supportIndex` is *rejected*, not silently dropped, so client/server mismatches surface), `'optional'` = either. The support slot is exempt from the duplicate-hero and duplicate-active rules (it may repeat another slot's hero and/or active sidekick); every other slot may not repeat a hero or a non-null active sidekick.
- It is displayed with a light cyan background (`--cms-support-bg`) in the summary, detail dialog, editor and admin, plus a text label so it is not colour-only.
- Passive sidekicks **may repeat across different slots** (only duplicates within one hero are forbidden). Hero and sidekick stockIds share a number space (Akashi hero 10011 / Akashi sidekick 10011), which is why a hero cannot use its own card as active sidekick.
- Defaults confirmed with the owner: engravement 0 (range 0–1000), level 60, P.Lv 0, fans 0. The editor reorders whole slots by drag and drop (mouse and touch, with an accessible up/down alternative), and `supportIndex` follows its slot.
- The roster existence check is soft (only when the roster was fetched), and the "no sidekick of the hero's own character" rule needs the roster's `characterId`.
- The **focus-card rule** (`options.focus`: a team in that group must feature the card) is a generic group option that the single `all` group no longer uses. It stays supported by the validator.
- A group's options are re-validated against only when a moderator edits or moves a submission: the payload is always validated against the *resulting* group, so moving between support and no-support groups needs `supportIndex` fixed in the same request. Flipping `support` in the wiki later does not auto-reject approved rows.
- Demo links are optional; allowed hosts are YouTube, Bilibili (`bilibili.com`, `b23.tv`), X/Twitter and Bluesky only.

## Data migration

`scripts/data/2026-10-team-creator.sql` is one-off and game-specific, so it is neither in `migrations/` nor in the generic CLI. It is idempotent, and `test/data-migration.test.ts` runs it twice against seeded old-style rows. It moves rows to `all`, maps tags, turns the three SSS simulator group ids (`quest-616001/617001/618001`, which equal the new target ids) into `payload.target`, bumps `version`/`updated_at` so open edit dialogs get a conflict instead of overwriting, and writes one `data.migrate` audit row. `original` snapshots keep their old tags and group, which is why the admin's "original" view tolerates unknown tag keys (it prints `key: value`).

## Rollout (one-off)

Nothing goes to production until the owner says so (AGENTS.md: no `--remote`, `wrangler deploy`, `db:migrate:remote` or `secret put` unprompted). Each phase can ship on its own; run phase 3 right after phase 2 to keep the gap short (the other order shows an empty catalog that still uses the old tags). Update this section as phases ship, and delete it, with the matching section of SETUP.md, when phase 4 is done.

1. **Wiki, compatible (no visible change):** roster `limited`, the plugin with support `optional`, the target picker and chip, the new `plugin-api.ts`; the registry *adds* `all` (with `targets`) and keeps the old per-page groups. The Worker needs the registry to contain `all` before phase 2.
2. **wiki-cms:** `pnpm db:migrate:remote` (the `title` column), `pnpm deploy` (`PUBLISH_REV` 2: new blob shape, type def, embed with `openForm`), the data-migration SQL with `--remote`, then `cms republish --type lah-team-formation` and `cms republish --all`. From here on the remaining per-page embeds show empty lists; their forms still work, but new rows land in the old groups.
3. **Wiki:** publish `team-creator.md` with the Team Creator app, remove the per-page embeds, add the links to the page, cut the registry down to `all`. Deploy, then **run the SQL again** to sweep rows that arrived during the gap, and republish `all`. Phase 3 depends on phase 2 because the app calls `openForm`.
4. **Moderators** add names to the legacy rows in the admin. They appear after the 5 minute browser TTL; each edit already purges the cache tag.

Operational commands are in [SETUP.md](SETUP.md#team-creator-rollout-one-off). After deploying, run the cache smoke test with group `all`.

## Limits and follow-ups

- **Blob size.** One item is about 1–3 KB of payload plus up to roughly 10 KB of explanation HTML. Around 100 items is a few hundred KB, fine for KV, the edge cache and the CPU budget (the ETag hash is the only per-request work on a Worker hit). Revisit at about 300 items or 1 MB. The likely fix is moving `explanationHtml` out into a lazy per-item fetch (the explanation is collapsed in the UI anyway), or splitting by target.
- **Requests per Team Creator view:** the type config is not fetched by the page; the blob (5 min browser / 1 day edge) is requested once; `v1.js` (5 min) and the form chunk only after the first submit click. Each chara page view dropped from 1–4 Worker requests to none.
- **Target list size:** `options.targets` travels in the registry, in every blob (`groupOptions`) and in the admin groups response. At about 150 bytes per entry even 100 targets is negligible, and retired entries are kept for good.
- **Not built:** an `onSubmitted` callback from `openForm` (the list shows approved items only, so a new submission never appears at once anyway; add it when something needs it), and server-side rendering of the list into the static page (SEO or no-JS).

## Accounts and edits

Team submissions require a contributor account (`submit_auth = 'account'`): sign in with Discord (account at least 30 days old) through the popup, then submit. The submitter sees their own teams (including not-yet-public ones) under **My submissions** on the Team Creator page and can **edit** them; an edit of a published team is a pending revision that a moderator approves or rejects (with an optional reason shown to the submitter) while the published version stays live. Legacy anonymous submissions have no owner; a moderator can assign one on request (admin portal or `cms submission set-owner`). Design and security notes: [ARCHITECTURE.md](ARCHITECTURE.md#contributor-accounts). The public blob is unchanged (no owner or revision data).
