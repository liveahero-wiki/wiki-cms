// Local dev only: creates a user (+ moderator permissions) and a BetterAuth session in the LOCAL D1 and
// prints a `document.cookie = ...` snippet to paste into the browser console on http://localhost:8787.
//   node scripts/dev-login.mjs [userId] [--types lah-team-formation,other]
import { createHmac, randomUUID } from 'node:crypto'
import { readDevVars, runLocalSql, sqlLit } from './dev-lib.mjs'

const args = process.argv.slice(2)
let userId = 'dev-moderator'
let types = ['lah-team-formation']
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--types') types = (args[++i] ?? '').split(',').map((t) => t.trim()).filter(Boolean)
  else if (args[i].startsWith('--types=')) types = args[i].slice(8).split(',').map((t) => t.trim()).filter(Boolean)
  else if (!args[i].startsWith('--')) userId = args[i]
}

const secret = readDevVars().BETTER_AUTH_SECRET
if (!secret) throw new Error('BETTER_AUTH_SECRET missing from .dev.vars')

const DAY = 86_400_000
const now = Date.now()
const token = `dev-${userId}-${randomUUID()}`
const sql = [
  `INSERT OR IGNORE INTO user_tab (id,name,email,email_verified,created_at,updated_at) VALUES (${sqlLit(userId)},${sqlLit(`Dev ${userId}`)},${sqlLit(`${userId}@users.invalid`)},0,${now},${now});`,
  ...types.map((t) => `INSERT OR IGNORE INTO moderator_permission_tab (user_id,type,granted_by,created_at) VALUES (${sqlLit(userId)},${sqlLit(t)},NULL,${now});`),
  `INSERT INTO session_tab (id,expires_at,token,created_at,updated_at,user_id) VALUES (${sqlLit(randomUUID())},${now + 30 * DAY},${sqlLit(token)},${now},${now},${sqlLit(userId)});`,
].join('\n')
runLocalSql(sql)

// BetterAuth signed cookie: encodeURIComponent(token + '.' + base64(HMAC-SHA256(secret, token)))
const signature = createHmac('sha256', secret).update(token).digest('base64')
const value = encodeURIComponent(`${token}.${signature}`)
console.log(`User "${userId}" with permissions [${types.join(', ') || 'none'}] created in the local D1.`)
console.log('Paste into the browser console on http://localhost:8787 (or any localhost port), then reload:\n')
console.log(`document.cookie = "better-auth.session_token=${value}; path=/; max-age=${30 * 86400}"`)
