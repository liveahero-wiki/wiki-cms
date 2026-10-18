#!/usr/bin/env node
// wiki-cms admin CLI. Run with: node cli/cms.ts <command>   (Node >= 23.6 type stripping)
// Talks to D1 through `wrangler d1 execute` (--local by default, --remote for production).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { isDiscordThreadId, isDiscordWebhookUrl } from '../src/core/discord-webhook.ts'
import { hashInviteToken, newInviteToken } from '../src/core/invites.ts'
import { ipKey } from '../src/core/ip.ts'
import { sql } from './sql.ts'

const DB_NAME = 'wiki_cms_db'
const INVITE_TTL_MS = 24 * 60 * 60 * 1000
const require = createRequire(import.meta.url)

const HELP = `wiki-cms CLI

Global flags: --remote (act on the production database; default is --local), --json

  cms type add <id> --name <name> --origins <o1,o2> --plugin-url <url> --groups-url <url>
  cms type update <id> [--name] [--origins] [--plugin-url] [--groups-url] [--enable|--disable]
                       [--discord-webhook <url|none>] [--discord-thread <id|none>] [--webhook-per-hour <n>]
                       [--submit-auth <anonymous|account>]
  cms type list
  cms invite create --types <t1,t2> [--base-url <PUBLIC_URL>]
  cms mod list
  cms mod grant <userId> --types <t1,t2>
  cms mod revoke <userId> [--types <t1>]        (no --types: remove all permissions and delete sessions)
  cms submission set-owner <submissionId> --user <contributorUserId|none>   (assign/clear the contributor who owns a legacy submission)
  cms ip block <ip> [--reason <text>]
  cms ip unblock <ip>
  cms republish --type <t> [--group <g>] --url <PUBLIC_URL>      (needs CLI_TOKEN in the environment)
  cms republish --all --url <PUBLIC_URL>                         (purge everything)
`

class UsageError extends Error {}

type Row = Record<string, unknown>

function wranglerBin(): string {
  return join(dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js')
}

/** Runs SQL through wrangler and returns the rows of the LAST statement that produced results. */
function runSql(statements: string[], remote: boolean): Row[] {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-cms-'))
  try {
    const file = join(dir, 'q.sql')
    writeFileSync(file, statements.join(';\n') + ';\n')
    const out = execFileSync(
      process.execPath,
      [wranglerBin(), 'd1', 'execute', DB_NAME, remote ? '--remote' : '--local', '--json', '--file', file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 },
    )
    const parsed = JSON.parse(out.slice(out.indexOf('['))) as { results?: Row[]; success?: boolean }[]
    const withRows = parsed.filter((p) => Array.isArray(p.results) && p.results.length > 0)
    return withRows.length ? withRows[withRows.length - 1]!.results! : []
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const auditSql = (action: string, type: string | null, target: string | null, detail?: unknown) =>
  sql`INSERT INTO audit_log_tab (at, actor, action, type, target, detail) VALUES (${Date.now()}, ${'cli'}, ${action}, ${type}, ${target}, ${detail === undefined ? null : JSON.stringify(detail)})`

function csv(v: string | undefined, flag: string): string[] {
  const list = (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!list.length) throw new UsageError(`${flag} is required`)
  return list
}

function table(rows: Row[]) {
  if (!rows.length) return console.log('(none)')
  console.table(rows)
}

function defaultBaseUrl(remote: boolean): string {
  if (!remote) return 'http://localhost:8787'
  try {
    const raw = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '')
    const url = JSON.parse(raw).vars?.PUBLIC_URL
    if (typeof url === 'string') return url
  } catch {
    /* fall through */
  }
  throw new UsageError('Could not determine PUBLIC_URL; pass --base-url')
}

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      remote: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      name: { type: 'string' },
      origins: { type: 'string' },
      'plugin-url': { type: 'string' },
      'groups-url': { type: 'string' },
      'discord-webhook': { type: 'string' },
      'discord-thread': { type: 'string' },
      'webhook-per-hour': { type: 'string' },
      'submit-auth': { type: 'string' },
      user: { type: 'string' },
      enable: { type: 'boolean', default: false },
      disable: { type: 'boolean', default: false },
      types: { type: 'string' },
      'base-url': { type: 'string' },
      reason: { type: 'string' },
      type: { type: 'string' },
      group: { type: 'string' },
      url: { type: 'string' },
      all: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const [cmd, sub, arg] = positionals
  const remote = values.remote!
  if (values.help || !cmd) return console.log(HELP)

  switch (`${cmd} ${sub ?? ''}`.trim()) {
    case 'type add': {
      if (!arg) throw new UsageError('type id required')
      const origins = csv(values.origins, '--origins')
      if (!values.name || !values['plugin-url'] || !values['groups-url']) throw new UsageError('--name, --plugin-url and --groups-url are required')
      runSql(
        [
          sql`INSERT INTO submission_type_tab (id, name, enabled, allowed_origins, plugin_url, groups_url, created_at) VALUES (${arg}, ${values.name}, 1, ${origins}, ${values['plugin-url']}, ${values['groups-url']}, ${Date.now()})`,
          auditSql('cli.type_add', arg, arg, { origins }),
        ],
        remote,
      )
      return console.log(`Added type ${arg}`)
    }
    case 'type update': {
      if (!arg) throw new UsageError('type id required')
      const sets: string[] = []
      const cols: string[] = [] // audited by column name only: the Discord webhook URL is a secret
      const set = (col: string, expr: string) => {
        cols.push(col)
        sets.push(expr)
      }
      if (values.name) set('name', sql`name = ${values.name}`)
      if (values.origins) set('allowed_origins', sql`allowed_origins = ${csv(values.origins, '--origins')}`)
      if (values['plugin-url']) set('plugin_url', sql`plugin_url = ${values['plugin-url']}`)
      if (values['groups-url']) set('groups_url', sql`groups_url = ${values['groups-url']}`)
      if (values.enable && values.disable) throw new UsageError('use only one of --enable / --disable')
      if (values.enable) set('enabled', 'enabled = 1')
      if (values.disable) set('enabled', 'enabled = 0')
      const hook = values['discord-webhook']
      if (hook !== undefined) {
        if (hook !== 'none' && !isDiscordWebhookUrl(hook)) throw new UsageError('--discord-webhook must be https://discord.com/api/webhooks/<id>/<token> (or "none")')
        set('discord_webhook_url', sql`discord_webhook_url = ${hook === 'none' ? null : hook}`)
      }
      const thread = values['discord-thread']
      if (thread !== undefined) {
        if (thread !== 'none' && !isDiscordThreadId(thread)) throw new UsageError('--discord-thread must be a numeric thread id (or "none")')
        set('discord_thread_id', sql`discord_thread_id = ${thread === 'none' ? null : thread}`)
      }
      const perHour = values['webhook-per-hour']
      if (perHour !== undefined) {
        if (!/^[1-9]d{0,5}$/.test(perHour)) throw new UsageError('--webhook-per-hour must be a positive integer')
        set('webhook_per_hour', sql`webhook_per_hour = ${Number(perHour)}`)
      }
      const submitAuth = values['submit-auth']
      if (submitAuth !== undefined) {
        if (submitAuth !== 'anonymous' && submitAuth !== 'account') throw new UsageError('--submit-auth must be anonymous or account')
        set('submit_auth', sql`submit_auth = ${submitAuth}`)
      }
      if (!sets.length) throw new UsageError('nothing to update')
      runSql([`UPDATE submission_type_tab SET ${sets.join(', ')} WHERE id = ${sql`${arg}`}`, auditSql('cli.type_update', arg, arg, { set: cols })], remote)
      return console.log(`Updated type ${arg}. Run "cms republish --type ${arg}" so cached configs refresh.`)
    }
    case 'type list':
      return table(runSql(['SELECT id, name, enabled, allowed_origins, plugin_url, groups_url, discord_webhook_url IS NOT NULL AS discord_webhook, discord_thread_id, webhook_per_hour, submit_auth FROM submission_type_tab ORDER BY id'], remote))

    case 'invite create': {
      const types = csv(values.types, '--types')
      const now = Date.now()
      const token = newInviteToken()
      const hash = await hashInviteToken(token)
      runSql(
        [
          sql`INSERT INTO invite_tab (token_hash, created_by, types, created_at, expires_at) VALUES (${hash}, NULL, ${types}, ${now}, ${now + INVITE_TTL_MS})`,
          auditSql('cli.invite_create', null, hash.slice(0, 12), { types }),
        ],
        remote,
      )
      const base = (values['base-url'] ?? defaultBaseUrl(remote)).replace(/\/$/, '')
      console.log(`${base}/invite/${token}`)
      return console.error('Single use, valid for 24 hours.')
    }

    case 'mod list':
      return table(
        runSql(
          [
            `SELECT u.id, u.name, GROUP_CONCAT(p.type) AS types FROM moderator_permission_tab p JOIN user_tab u ON u.id = p.user_id GROUP BY u.id ORDER BY u.name`,
          ],
          remote,
        ),
      )
    case 'mod grant': {
      if (!arg) throw new UsageError('user id required')
      const types = csv(values.types, '--types')
      const now = Date.now()
      runSql(
        [
          ...types.map((t) => sql`INSERT OR IGNORE INTO moderator_permission_tab (user_id, type, granted_by, created_at) VALUES (${arg}, ${t}, NULL, ${now})`),
          auditSql('cli.permission_grant', null, arg, { types }),
        ],
        remote,
      )
      return console.log(`Granted ${types.join(', ')} to ${arg}`)
    }
    case 'mod revoke': {
      if (!arg) throw new UsageError('user id required')
      if (values.types) {
        const types = csv(values.types, '--types')
        runSql([...types.map((t) => sql`DELETE FROM moderator_permission_tab WHERE user_id = ${arg} AND type = ${t}`), auditSql('cli.permission_revoke', null, arg, { types })], remote)
        return console.log(`Revoked ${types.join(', ')} from ${arg}`)
      }
      runSql(
        [
          sql`DELETE FROM moderator_permission_tab WHERE user_id = ${arg}`,
          sql`DELETE FROM session_tab WHERE user_id = ${arg}`,
          auditSql('cli.moderator_revoke', null, arg),
        ],
        remote,
      )
      return console.log(`Revoked all permissions and sessions of ${arg}`)
    }

    case 'submission set-owner': {
      if (!arg) throw new UsageError('submission id required')
      if (!values.user) throw new UsageError('--user <contributorUserId|none> is required')
      const owner = values.user === 'none' ? null : values.user
      if (!runSql([sql`SELECT id FROM submission_tab WHERE id = ${arg}`], remote).length) throw new UsageError('no such submission')
      if (owner && !runSql([sql`SELECT user_id FROM contributor_tab WHERE user_id = ${owner}`], remote).length) throw new UsageError('no such contributor')
      runSql(
        [
          sql`UPDATE submission_tab SET user_id = ${owner} WHERE id = ${arg}`,
          auditSql('cli.submission_set_owner', null, arg, { to: owner }),
        ],
        remote,
      )
      return console.log(`Owner of ${arg} set to ${owner ?? '(none)'}`)
    }

    case 'ip block': {
      const key = arg ? ipKey(arg) : null
      if (!key) throw new UsageError('a valid IP address is required')
      runSql(
        [
          sql`INSERT INTO ip_block_tab (ip_key, reason, created_by, created_at) VALUES (${key}, ${values.reason ?? null}, ${'cli'}, ${Date.now()}) ON CONFLICT(ip_key) DO UPDATE SET reason = excluded.reason, created_by = excluded.created_by, created_at = excluded.created_at`,
          auditSql('cli.ip_block_tab', null, key, { reason: values.reason ?? null }),
        ],
        remote,
      )
      return console.log(`Blocked ${key}`)
    }
    case 'ip unblock': {
      const key = arg ? ipKey(arg) : null
      if (!key) throw new UsageError('a valid IP address is required')
      runSql([sql`DELETE FROM ip_block_tab WHERE ip_key = ${key}`, auditSql('cli.ip_unblock', null, key)], remote)
      return console.log(`Unblocked ${key}`)
    }

    case 'republish': {
      const base = values.url ?? process.env.CMS_URL
      if (!base) throw new UsageError('--url <PUBLIC_URL> is required')
      const token = process.env.CLI_TOKEN
      if (!token) throw new UsageError('set CLI_TOKEN in the environment')
      if (!values.all && !values.type) throw new UsageError('--type <t> or --all is required')
      const res = await fetch(`${base.replace(/\/$/, '')}/api/internal/republish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(values.all ? { all: true } : { type: values.type, ...(values.group ? { group: values.group } : {}) }),
      })
      const text = await res.text()
      console.log(res.status, text)
      if (!res.ok) process.exitCode = 1
      return
    }
    default:
      throw new UsageError(`unknown command: ${cmd} ${sub ?? ''}`.trim())
  }
}

main(process.argv.slice(2)).catch((e) => {
  if (e instanceof UsageError) {
    console.error(`Error: ${e.message}\n`)
    console.error(HELP)
  } else {
    console.error(e instanceof Error ? e.message : e)
  }
  process.exitCode = 1
})
