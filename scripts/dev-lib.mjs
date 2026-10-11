// Shared helpers for the local-only dev scripts (dev-login, dev-seed). Never touches a remote database.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

/** SQL literal: strings get single quotes doubled; NUL is rejected. */
export function sqlLit(v) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`Non-finite number: ${v}`)
    return String(v)
  }
  if (typeof v === 'boolean') return v ? '1' : '0'
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  if (s.includes('\0')) throw new Error('NUL in SQL string')
  return `'${s.replaceAll("'", "''")}'`
}

/** Runs SQL against the LOCAL D1 database through wrangler. */
export function runLocalSql(sql) {
  const wranglerBin = join(dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js')
  const dir = mkdtempSync(join(tmpdir(), 'wiki-cms-'))
  const file = join(dir, 'script.sql')
  try {
    writeFileSync(file, sql)
    const r = spawnSync(process.execPath, [wranglerBin, 'd1', 'execute', 'wiki_cms_db', '--local', '--file', file], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    if (r.status !== 0) throw new Error(`wrangler failed (${r.status}):\n${r.stdout}\n${r.stderr}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Reads KEY=VALUE pairs from .dev.vars. */
export function readDevVars() {
  const out = {}
  for (const line of readFileSync(join(ROOT, '.dev.vars'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}
