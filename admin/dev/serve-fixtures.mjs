// Local dev only: serves a fake wiki on http://localhost:8080 (groups registry + plugin) for the seeded type.
//   node admin/dev/serve-fixtures.mjs
//   node admin/dev/serve-fixtures.mjs --single-group   # the production shape: one group, so the admin hides every group control
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

// Several groups, which is what the admin's group filter, chips and picker are there for. The real
// wiki publishes a single group (`all`); pair --single-group with the same flag on dev-seed.mjs.
const groups = process.argv.includes('--single-group')
  ? { groups: { all: { title: 'Team Creator', url: '/team-creator.html', options: { support: 'optional', targets: [] } } } }
  : {
      groups: {
        'quest-1': { title: 'Worthy Foe › SS-Rank', url: '/events/2607HighDifficultRevival/#team-quest-1', options: { support: false } },
        'quest-2': { title: 'Worthy Foe › S-Rank', url: '/events/2607HighDifficultRevival/#team-quest-2' },
        'hero-10251': { title: 'Andrew – "The Riptide"', url: '/charas/andrew/#team-hero-10251', options: { support: true, focus: { kind: 'hero', stockId: 10251 } } },
        'hero-10261': { title: 'Brian – "The Brute"', url: '/charas/brian/#team-hero-10261', options: { support: true, focus: { kind: 'hero', stockId: 10261 } } },
      },
    }
const plugin = readFileSync(new URL('./stub-plugin.js', import.meta.url))
const routes = {
  '/api/cms-groups.json': ['application/json', JSON.stringify(groups)],
  '/assets/cms/stub-plugin.js': ['text/javascript', plugin],
}
createServer((req, res) => {
  const hit = routes[new URL(req.url, 'http://x').pathname]
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.writeHead(hit ? 200 : 404, { 'Content-Type': hit?.[0] ?? 'text/plain' })
  res.end(hit?.[1] ?? 'not found')
}).listen(8080, () => console.log('fixtures on http://localhost:8080'))
