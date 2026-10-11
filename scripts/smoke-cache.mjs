#!/usr/bin/env node
// Post-deploy smoke test for Workers Cache (see docs/SETUP.md §4).
// Usage: node scripts/smoke-cache.mjs <PUBLIC_URL> <type> <group>
const [base, type, group] = process.argv.slice(2)
if (!base || !type || !group) {
  console.error('Usage: node scripts/smoke-cache.mjs <PUBLIC_URL> <type> <group>')
  process.exit(2)
}

const root = base.replace(/\/$/, '')
const listUrl = `${root}/api/v1/submissions/${type}/${group}`
let failures = 0
const check = (ok, msg, hint = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}${!ok && hint ? `\n      → ${hint}` : ''}`)
  if (!ok) failures++
}
const get = async (url, init) => {
  const res = await fetch(url, init)
  await res.arrayBuffer()
  return res
}
const status = (res) => (res.headers.get('cf-cache-status') ?? 'none').toUpperCase()

// 1. List endpoint: first request fills, second must HIT.
const first = await get(listUrl)
check(first.status === 200, `GET list → 200 (got ${first.status})`)
console.log(`      first request cf-cache-status=${status(first)}`)
const second = await get(listUrl)
check(status(second) === 'HIT', `second request is a cache HIT (got ${status(second)})`, 'Workers Cache not active on this origin? Check `cache.enabled` in wrangler.jsonc and the account/plan.')
check(second.headers.get('cache-control')?.includes('s-maxage=86400') ?? false, 'Cache-Control carries s-maxage=86400 (edge TTL fallback)')
check(!!second.headers.get('etag'), 'ETag present')
check(second.headers.get('access-control-allow-origin') === '*', 'CORS: Access-Control-Allow-Origin: *')
check(!second.headers.get('cache-tag'), 'Cache-Tag header is stripped before reaching the client')

// 2. Query strings are separate cache entries (the client must never add params).
const q = await get(`${listUrl}?x=${Date.now()}`)
check(status(q) !== 'HIT', 'a never-seen query string is a MISS (separate cache entry)')

// 3. Never-cached routes.
const me = await get(`${root}/api/admin/me`)
check(me.status === 401 && status(me) !== 'HIT', `/api/admin/me is 401 and not cached (status ${me.status}, ${status(me)})`)
check((me.headers.get('cache-control') ?? '').includes('no-store'), '/api/admin/me is Cache-Control: no-store')
const post = await get(listUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
check(status(post) !== 'HIT', `POST is never a cache HIT (got ${status(post)}, http ${post.status})`)

// 4. Unknown group: short TTL, no long caching.
const unknown = await get(`${root}/api/v1/submissions/${type}/definitely-not-a-group-${Date.now()}`)
check((unknown.headers.get('cache-control') ?? '').includes('max-age=60') && !(unknown.headers.get('cache-control') ?? '').includes('s-maxage'), 'unknown group: max-age=60, no s-maxage')

// 5. Invalidation is exercised manually.
console.log('\nManual step: run `CLI_TOKEN=… node cli/cms.ts republish --type ' + type + ' --group ' + group + ' --url ' + root + '`')
console.log('then re-run this script (or curl -sI the list URL): the next request should be MISS/REVALIDATED, then HIT again.')
console.log('Also confirm with `wrangler tail` that cache HITs do not invoke the Worker.')

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
