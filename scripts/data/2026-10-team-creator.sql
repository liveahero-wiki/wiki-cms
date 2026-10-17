-- One-off, game-specific data migration for the Team Creator (docs/TEAM_CREATOR.md, "Data migration").
-- Idempotent: safe to run again to sweep rows that arrived in an old group during the deploy gap.
--   wrangler d1 execute wiki_cms_db --local  --file scripts/data/2026-10-team-creator.sql
--   wrangler d1 execute wiki_cms_db --remote --file scripts/data/2026-10-team-creator.sql   (a deploy step: ask first)
-- Statements end with a semicolon at the end of a line; there are no semicolons inside strings.
-- A row "needs migration" when it is outside the `all` group, still has the old `rng` tag, or has no `teamType` tag.

-- 1. One audit row with the number of rows that are about to change (nothing is written when there are none).
INSERT INTO audit_log_tab (at, actor, action, type, target, detail)
SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'cli', 'data.migrate', 'lah-team-formation', NULL,
       json_object('script', '2026-10-team-creator', 'rows', n)
FROM (
  SELECT COUNT(*) AS n FROM submission_tab
  WHERE type = 'lah-team-formation'
    AND (group_id <> 'all' OR json_extract(tags, '$.rng') IS NOT NULL OR json_extract(tags, '$.teamType') IS NULL)
)
WHERE n > 0;

-- 2. Move to `all`, translate the tags (rng -> successRate, teamType = manual) and turn the old simulator
--    group id into the payload target. version/updated_at change so open admin edit dialogs get a conflict.
UPDATE submission_tab
SET
  tags = json_set(
    json_remove(tags, '$.rng'),
    '$.teamType', COALESCE(json_extract(tags, '$.teamType'), 'manual'),
    '$.successRate', COALESCE(
      json_extract(tags, '$.successRate'),
      CASE json_extract(tags, '$.rng')
        WHEN 'none' THEN 'high'
        WHEN 'few' THEN 'high'
        WHEN 'many' THEN 'medium'
        WHEN 'impractical' THEN 'low'
        ELSE 'medium'
      END
    )
  ),
  payload = CASE
    WHEN group_id IN ('quest-616001', 'quest-617001', 'quest-618001') THEN json_set(payload, '$.target', group_id)
    ELSE payload
  END,
  group_id = 'all',
  version = version + 1,
  updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE type = 'lah-team-formation'
  AND (group_id <> 'all' OR json_extract(tags, '$.rng') IS NOT NULL OR json_extract(tags, '$.teamType') IS NULL);
