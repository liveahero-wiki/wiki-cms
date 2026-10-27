// Local dev only: inserts sample submissions into the LOCAL D1 (type lah-team-formation).
//   node scripts/dev-seed.mjs            # adds a fresh batch (ids are random)
//   node scripts/dev-seed.mjs --reset    # first deletes all existing submissions of the type
//   node scripts/dev-seed.mjs --single-group  # one group (`all`), like production: no group controls
import { randomUUID } from 'node:crypto'
import { renderExplanation } from '../src/shared/markdown-policy.ts'
import { runLocalSql, sqlLit } from './dev-lib.mjs'

const TYPE = 'lah-team-formation'
const MIN = 60_000
const now = Date.now()

const team = (ids, supportIndex = null) => ({
  v: 1,
  supportIndex,
  heroes: ids.map((stockId) => ({ stockId, lv: 60, plv: 0, fans: 0, engrave: 0, bloom: false, skillTree: false, active: null, passives: [] })),
})
const demos = ['https://youtu.be/dQw4w9WgXcQ', 'https://x.com/someone/status/1', 'https://bsky.app/profile/someone/post/abc']

const rows = []
function add(o) {
  const explanation = o.explanation ?? '## Overview\nWorks well on turn 3.\n\n- Use **skill A** first\n- Keep the buffer alive'
  const createdAt = now - (o.minsAgo ?? 5) * MIN
  rows.push({
    id: randomUUID(),
    type: TYPE,
    groupId: o.group,
    state: o.state ?? 'pending',
    version: o.version ?? 1,
    title: o.title ?? '',
    payload: o.payload,
    tags: o.tags ?? { rng: 'few' },
    lang: o.lang ?? 'en',
    explanation,
    explanationHtml: renderExplanation(explanation),
    demoUrl: o.demoUrl ?? demos[rows.length % demos.length],
    createdAt,
    updatedAt: createdAt,
    stateChangedAt: createdAt,
    original: o.original ?? null,
    ip: o.ip ?? '203.0.113.7',
    ipKey: o.ipKey ?? o.ip ?? '203.0.113.7',
    country: o.country ?? 'JP',
    aiVerdict: o.aiVerdict ?? null,
    aiReason: o.aiReason ?? null,
  })
}

// Legacy rows (old per-page groups, `rng` tag, no title) are kept on purpose: they exercise
// scripts/data/2026-10-team-creator.sql (`wrangler d1 execute wiki_cms_db --local --file ...`).
// `all` (needs the registry to list it): new-style rows with titles, the new tags and an optional target.
add({ group: 'all', title: 'SSS Lantern auto clear', payload: { ...team([10011, 10021, 10031]), target: 'quest-616001' }, minsAgo: 20, state: 'approved', tags: { teamType: 'auto', successRate: 'high' } })
add({ group: 'all', title: 'Budget manual run', payload: team([10041, 10051, 10061], 2), minsAgo: 60, state: 'approved', tags: { teamType: 'manual', successRate: 'medium' } })
add({ group: 'all', title: 'Pending new-style team', payload: team([10011, 10061]), minsAgo: 2, tags: { teamType: 'manual', successRate: 'low' } })

// quest-1: no support allowed
add({ group: 'quest-1', payload: team([10011, 10021, 10031]), minsAgo: 3, country: 'US', ip: '198.51.100.20' })
add({ group: 'quest-1', payload: team([10011, 10041, 10051]), minsAgo: 40, state: 'approved', lang: 'ja', country: 'JP', tags: { rng: 'none' } })
add({ group: 'quest-1', payload: team([10011]), minsAgo: 300, state: 'spam', explanation: 'BUY CHEAP GEMS now\n\nbest team ever', country: 'RU', ip: '203.0.113.99', aiVerdict: 'spam', aiReason: 'Promotional text unrelated to the game.' })
// quest-2: support slot required
add({ group: 'quest-2', payload: team([10011, 10021, 10011], 2), minsAgo: 12, lang: 'zh-Hans', country: 'CN', ip: '198.51.100.21', tags: { rng: 'many' } })
add({ group: 'quest-2', payload: team([10061, 10071, 10081], 0), minsAgo: 90, state: 'approved', country: 'SG', ip: '198.51.100.22' })
add({
  group: 'quest-2',
  payload: team([10061, 10071, 10081], 1),
  minsAgo: 200,
  state: 'approved',
  version: 2,
  explanation: 'Edited by a moderator.\n\n1. Go first\n2. Then second',
  original: { payload: team([10061, 10071]), tags: { rng: 'few' }, lang: 'en', explanation: 'Original text with typos', demoUrl: demos[0], groupId: 'quest-2' },
  country: 'TW',
  ip: '2001:db8:1:2:aaaa:bbbb:cccc:dddd',
  ipKey: '2001:db8:1:2::',
})
// hero-10251: must include hero 10251
add({ group: 'hero-10251', payload: team([10251, 10261, 10011], 1), minsAgo: 7, country: 'DE', ip: '198.51.100.23', aiVerdict: 'ok' })
add({ group: 'hero-10251', payload: team([10251, 10021, 10031], 2), minsAgo: 500, state: 'approved', country: 'KR', ip: '198.51.100.24', tags: { rng: 'impractical' } })
// A flood from one IP in quest-2 (> 50 pending: exercises "Load more" and bulk spam in chunks).
for (let i = 0; i < 55; i++) {
  add({ group: 'quest-2', payload: team([10011, 10021], 0), minsAgo: 1000 + i, country: 'ZZ', ip: '192.0.2.66', explanation: `Flood message #${i + 1}` })
}

const cols = ['id', 'type', 'groupId', 'state', 'title', 'version', 'payload', 'tags', 'lang', 'explanation', 'explanationHtml', 'demoUrl', 'createdAt', 'updatedAt', 'stateChangedAt', 'original', 'ip', 'ipKey', 'country', 'aiVerdict', 'aiReason']
const dbCols = ['id', 'type', 'group_id', 'state', 'title', 'version', 'payload', 'tags', 'lang', 'explanation', 'explanation_html', 'demo_url', 'created_at', 'updated_at', 'state_changed_at', 'original', 'ip', 'ip_key', 'country', 'ai_verdict', 'ai_reason']
const lit = (v) => sqlLit(typeof v === 'object' && v !== null ? JSON.stringify(v) : v)

// Production has one group (`all`), which hides the admin's group filter, chips and picker; the
// default seed keeps several groups so the multi-group path stays testable.
if (process.argv.includes('--single-group')) for (const r of rows) r.groupId = 'all'

// One pending contributor edit of an approved team, for the Contributor edits view and its badges.
// `user_id` stays null (no contributor account is seeded), which the admin shows as an unknown owner.
const edited = rows.find((r) => r.state === 'approved')
const revCols = ['id', 'submission_id', 'user_id', 'state', 'base_version', 'title', 'payload', 'tags', 'lang', 'explanation', 'explanation_html', 'demo_url', 'created_at']
const revExplanation = 'Swapped the third hero: the original line-up died to the AoE.'
const revValues = edited && [
  randomUUID(),
  edited.id,
  null,
  'pending',
  edited.version,
  `${edited.title || 'Untitled'} (contributor edit)`,
  edited.payload,
  edited.tags,
  edited.lang,
  revExplanation,
  renderExplanation(revExplanation),
  edited.demoUrl,
  now - 4 * MIN,
]

const sql = [
  ...(process.argv.includes('--reset') ? [`DELETE FROM submission_tab WHERE type = ${sqlLit(TYPE)};`] : []),
  ...rows.map((r) => `INSERT INTO submission_tab (${dbCols.join(',')}) VALUES (${cols.map((c) => lit(r[c])).join(',')});`),
  ...(revValues ? [`INSERT INTO submission_revision_tab (${revCols.join(',')}) VALUES (${revValues.map(lit).join(',')});`] : []),
].join('\n')
runLocalSql(sql)
console.log(`Inserted ${rows.length} submissions${revValues ? ' and 1 pending contributor edit' : ''} into the local D1.`)
