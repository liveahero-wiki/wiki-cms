// Dependency-free mock of the wiki-cms public API + static host for the embed dev page.
//   pnpm build:embed && node embed/dev-server.mjs   →   http://localhost:8788/
// Magic explanation texts (type them into the form): FAIL (validation_failed with sample fields),
// RATE (429 rate_limited), CAP (429 daily_cap), TURN (403 turnstile_failed), WEIRD (unknown code with an English message).
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const PORT = Number(process.env.PORT ?? 8788)
const here = import.meta.dirname
const distEmbed = join(here, '..', 'dist', 'public', 'embed')

const TYPE = 'lah-team-formation'
const TARGETS = [
  { id: 'quest-616001', label: { en: 'Simulator - Lantern-type Kaibutsu (SSS)', ja: 'シミュレーター - ランタン型怪物 (SSS)' }, url: '/guide/challenge_simulator/' },
  { id: 'quest-617001', label: { en: 'Simulator - Plant-type Kaibutsu (SSS)' } },
  { id: 'rogue-2609', label: { en: 'Unexplored: final boss' }, retired: true },
]
// everything else is "unknown"; `all` is the catalog group, the others are legacy card-list groups
const GROUPS = { all: { support: 'optional', targets: TARGETS }, 'quest-1272003': { support: true }, 'quest-1272004': { support: false } }

const langs = [
  { value: 'en', label: 'English' },
  { value: 'zh-Hans', label: '简体中文' },
  { value: 'zh-Hant', label: '繁體中文' },
  { value: 'ja', label: '日本語' },
]
const tags = [
  {
    key: 'teamType',
    label: { en: 'Team type', 'zh-Hans': '队伍类型', 'zh-Hant': '隊伍類型', ja: '編成タイプ' },
    required: true,
    default: 'manual',
    options: [
      { value: 'manual', label: { en: 'Manual', 'zh-Hans': '手动', 'zh-Hant': '手動', ja: '手動' } },
      { value: 'auto', label: { en: 'Full auto', 'zh-Hans': '全自动', 'zh-Hant': '全自動', ja: 'フルオート' } },
    ],
  },
  {
    key: 'successRate',
    label: { en: 'Success rate', 'zh-Hans': '成功率', 'zh-Hant': '成功率', ja: '成功率' },
    required: true,
    options: [
      { value: 'high', label: { en: 'High', 'zh-Hans': '高', 'zh-Hant': '高', ja: '高い' } },
      { value: 'medium', label: { en: 'Medium (some retries)', 'zh-Hans': '中（需重试）', 'zh-Hant': '中（需重試）', ja: '普通（リトライあり）' } },
      { value: 'low', label: { en: 'Low (near impractical)', 'zh-Hans': '低（几乎不现实）', 'zh-Hant': '低（幾乎不實際）', ja: '低い（ほぼ非現実的）' } },
    ],
  },
]
const titleRules = {
  required: true,
  minLength: 4,
  maxLength: 50,
  label: { en: 'Team name', 'zh-Hans': '队伍名称', 'zh-Hant': '隊伍名稱', ja: '編成名' },
  placeholder: { en: 'e.g. SSS Lantern – 3-turn clear', 'zh-Hans': '例如：SSS 灯笼型 3 回合通关', 'zh-Hant': '例如：SSS 燈籠型 3 回合通關', ja: '例：SSS ランタン型 3ターン攻略' },
}
const template = {
  en: '## Overview\n_What does this team do, and how does it win?_\n\n## Key heroes & sidekicks\n-\n\n## Strategy / turn order\n1.\n\n## Notes\n_Substitutes, important skill-tree nodes, what to do when RNG goes wrong._\n',
  ja: '## 概要\n_どのクエスト／難易度向けの編成ですか？_\n\n## 主要なヒーロー＆サイドキック\n-\n\n## 立ち回り／ターン順\n1.\n\n## 補足\n_代役、重要なスキルツリーのノード、運が悪かった時の対処など。_\n',
  'zh-Hans': '## 概述\n_这套队伍适用于哪个任务／难度？_\n\n## 主要英雄与助手\n-\n\n## 打法／回合顺序\n1.\n\n## 备注\n_替补人选、重要的技能树节点、运气不好时的应对方法。_\n',
  'zh-Hant': '## 概述\n_這套隊伍適用於哪個任務／難度？_\n\n## 主要英雄與助手\n-\n\n## 打法／回合順序\n1.\n\n## 備註\n_替補人選、重要的技能樹節點、運氣不好時的應對方法。_\n',
}
const config = {
  type: TYPE,
  name: 'Team formations',
  langs,
  tags,
  title: titleRules,
  explanation: { maxLength: 5000, template },
  demoUrl: {
    required: true,
    allowedHosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'x.com', 'www.x.com', 'bsky.app'],
  },
  turnstileSiteKey: '1x00000000000000000000AA', // Cloudflare's always-passes test key
  disclaimer: null,
}

// ---- fixture blob ----
const demos = ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://x.com/someone/status/1234567890', 'https://bsky.app/profile/someone.bsky.social/post/3kabc']
const rates = ['high', 'medium', 'low']
const NAMES = ['SSS Lantern auto clear', 'Parallel Quartz S – 2 turns', 'ランタン型 3ターン攻略', '灯笼型 稳定通关', 'HDQ event boss', 'Budget team, no limited heroes', 'Fast manual run', '燈籠型 低成本隊伍']
const langCycle = ['en', 'en', 'ja', 'zh-Hans', 'en', 'zh-Hant']
const shortHtml = '<h3>Overview</h3><p>Clear in <strong>3 turns</strong> with <em>no RNG</em>.</p><ul><li>Hero A first</li><li>Then the support</li></ul>'
const longHtml =
  '<h3>Overview</h3><p>This formation clears the quest in a handful of turns. Read the notes carefully before copying it.</p>' +
  '<h4>Key heroes &amp; sidekicks</h4><ul>' +
  Array.from({ length: 6 }, (_, i) => `<li>Slot ${i + 1}: use skill ${i + 1} on turn ${i + 1}, then wait for the buff to land.</li>`).join('') +
  '</ul><h4>Strategy / turn order</h4><ol>' +
  Array.from({ length: 8 }, (_, i) => `<li>Turn ${i + 1}: <code>action-${i + 1}</code> and hope the RNG cooperates. It usually does.</li>`).join('') +
  '</ol><p>' + 'A very long line without any spaces: ' + 'x'.repeat(120) + '</p><h4>Notes</h4><p>Substitutes: anyone with a taunt. Skill tree: take every damage node.</p>'

function makeItems(group) {
  const opt = GROUPS[group]
  const support = opt?.support !== false
  return Array.from({ length: 27 }, (_, i) => ({
    id: `fixture-${group}-${i}`,
    createdAt: Date.UTC(2026, 9, 11) - i * 86_400_000 * 1.7,
    title: i % 7 === 6 ? '' : `${NAMES[i % NAMES.length]} #${i + 1}`,
    lang: langCycle[i % langCycle.length],
    tags: { teamType: i % 3 === 0 ? 'auto' : 'manual', successRate: rates[i % 3] },
    demoUrl: demos[i % 3],
    explanationHtml: i % 3 === 0 ? longHtml : shortHtml,
    payload: {
      v: 1,
      supportIndex: support ? 2 : null,
      heroes: [10011, 10021, 10031, 10041, 10051].slice(0, 3 + (i % 3)).map((stockId, n) => ({ stockId: stockId + (i % 4) * 100, lv: 60, active: n === 0 ? 10021 : null, passives: [] })),
    },
  }))
}

/** ~60 catalog fixtures for the `all` group (targets, optional support, some legacy untitled rows). */
function makeCatalogItems() {
  return Array.from({ length: 60 }, (_, i) => {
    const target = i % 4 === 3 ? undefined : TARGETS[i % TARGETS.length].id
    return {
      id: `catalog-${i}`,
      createdAt: Date.UTC(2026, 9, 11) - i * 86_400_000 * 0.9,
      title: i % 9 === 8 ? '' : `${NAMES[i % NAMES.length]} #${i + 1}`,
      lang: langCycle[i % langCycle.length],
      tags: { teamType: i % 3 === 0 ? 'auto' : 'manual', successRate: rates[i % 3] },
      demoUrl: i % 2 ? demos[i % 3] : '',
      explanationHtml: i % 3 === 0 ? longHtml : shortHtml,
      payload: {
        v: 1,
        supportIndex: i % 2 ? 2 : null,
        ...(target ? { target } : {}),
        heroes: [10011, 10021, 10031, 10041, 10051].slice(0, 3 + (i % 3)).map((stockId, n) => ({ stockId: stockId + (i % 4) * 100, lv: 60, active: n === 0 ? 10021 : null, passives: [] })),
      },
    }
  })
}

function blobFor(group) {
  const known = group in GROUPS
  return {
    v: 1,
    type: TYPE,
    group,
    generatedAt: Date.now(),
    groupOptions: known ? GROUPS[group] : {},
    meta: { langs, tags, title: true },
    items: group === 'quest-1272003' ? makeItems(group) : group === 'all' ? makeCatalogItems() : [],
  }
}

// ---- http ----
const MIME = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.json': 'application/json' }

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && body !== null
  res.writeHead(status, { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain', ...headers })
  res.end(status === 204 || status === 304 ? undefined : isObj ? JSON.stringify(body) : body)
}
const apiError = (res, status, code, message, fields, headers) => send(res, status, { error: { code, message, ...(fields ? { fields } : {}) } }, headers)

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

async function serveFile(res, file, extra = {}) {
  try {
    const data = await readFile(file)
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache', ...extra })
    res.end(data)
  } catch {
    send(res, 404, 'Not found')
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const path = url.pathname
  console.log(req.method, path + url.search)
  const origin = req.headers.origin
  try {
    // Static
    if (req.method === 'GET' && (path === '/' || path === '/dev.html')) return serveFile(res, join(here, 'dev.html'))
    if (req.method === 'GET' && path === '/dev-plugin.js') return serveFile(res, join(here, 'dev-plugin.js'))
    if (req.method === 'GET' && path.startsWith('/embed/')) {
      const rel = normalize(path.slice('/embed/'.length)).replace(/^(\.\.[\\/])+/, '')
      return serveFile(res, join(distEmbed, rel))
    }

    // API
    let m = path.match(/^\/api\/v1\/types\/([^/]+)$/)
    if (req.method === 'GET' && m) {
      if (m[1] !== TYPE) return apiError(res, 404, 'unknown_type', 'Unknown submission type.')
      return send(res, 200, config, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' })
    }
    m = path.match(/^\/api\/v1\/submissions\/([^/]+)\/([^/]+)$/)
    if (m) {
      const [, type, group] = m
      if (type !== TYPE) return apiError(res, 404, 'unknown_type', 'Unknown submission type.', undefined, { 'Access-Control-Allow-Origin': '*' })
      if (req.method === 'GET') {
        return send(res, 200, blobFor(group), { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' })
      }
      if (req.method === 'OPTIONS') {
        if (!origin) return send(res, 403, '')
        return send(res, 204, '', {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin',
        })
      }
      if (req.method === 'POST') {
        const cors = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}
        let body
        try {
          body = JSON.parse(await readBody(req))
        } catch {
          return apiError(res, 400, 'bad_json', 'Invalid JSON body.', undefined, cors)
        }
        if (body.website) return send(res, 202, { id: 'honeypot', state: 'pending' }, cors)
        if (!(group in GROUPS)) return apiError(res, 404, 'unknown_group', 'Unknown group.', undefined, cors)
        const expl = String(body.explanation ?? '')
        if (expl.includes('RATE')) return apiError(res, 429, 'rate_limited', 'Too many submissions, please try again in a minute.', undefined, cors)
        if (expl.includes('CAP')) return apiError(res, 429, 'daily_cap', 'Daily submission limit reached.', undefined, cors)
        if (expl.includes('WEIRD')) return apiError(res, 418, 'teapot', 'The server is a teapot (English fallback message).', undefined, cors)
        const fields = []
        if (expl.includes('FAIL')) {
          fields.push(
            { path: 'title', code: 'title_too_short', message: 'The name must be at least 4 characters.', params: { min: 4 } },
            { path: 'tags.successRate', code: 'tag_required', message: 'Success rate is required.' },
            { path: 'payload.heroes.0.stockId', code: 'unknown_hero', message: 'Unknown hero.', params: { stockId: 10011 } },
            { path: 'payload.heroes', code: 'duplicate_hero', message: 'Slots 1, 3 use the same hero.', params: { slots: '1,3' } },
            { path: 'explanation', code: 'explanation_too_long', message: 'The explanation must be at most 5000 characters.', params: { max: 5000 } },
            { path: 'demoUrl', code: 'demo_host', message: 'The demo link must be a YouTube, X (Twitter) or Bluesky link.' },
            { path: 'somewhere.else', code: 'brand_new_code', message: 'A field-level message in English only.' },
          )
        }
        if (!body.tags?.successRate) fields.push({ path: 'tags.successRate', code: 'tag_required', message: 'Success rate is required.' })
        if (!body.title || String(body.title).trim().length < 4) fields.push({ path: 'title', code: String(body.title ?? '').trim() ? 'title_too_short' : 'title_required', message: 'A name of at least 4 characters is required.', params: { min: 4 } })
        if (!expl.trim()) fields.push({ path: 'explanation', code: 'explanation_required', message: 'An explanation is required.' })
        if (fields.length) return apiError(res, 400, 'validation_failed', 'Some fields are invalid.', fields, cors)
        if (expl.includes('TURN') || !body.turnstileToken) return apiError(res, 403, 'turnstile_failed', 'Verification failed. Please try again.', undefined, cors)
        console.log('  accepted submission', JSON.stringify({ title: body.title, lang: body.lang, tags: body.tags, demoUrl: body.demoUrl }))
        return send(res, 202, { id: crypto.randomUUID(), state: 'pending' }, cors)
      }
    }
    send(res, 404, 'Not found', { 'Access-Control-Allow-Origin': '*' })
  } catch (e) {
    console.error(e)
    send(res, 500, 'Internal error')
  }
}).listen(PORT, () => console.log(`wiki-cms embed dev server: http://localhost:${PORT}/`))
