import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import sqlText from '../scripts/data/2026-10-team-creator.sql?raw'
import { TYPE, resetState } from './helpers.ts'

// D1 `exec` wants one statement per line; split the script the way the file documents it (`;` at the end of a line).
const statements = sqlText
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .split(/;\s*(?:\n|$)/)
  .map((s) => s.trim())
  .filter(Boolean)

const runScript = async () => {
  for (const s of statements) await env.DB.prepare(s).run()
}

async function seed(id: string, group: string, tags: Record<string, string>, payload: Record<string, unknown> = {}, type = TYPE) {
  await env.DB.prepare(
    `INSERT INTO submission_tab (id,type,group_id,state,version,payload,tags,lang,explanation,explanation_html,demo_url,created_at,updated_at,state_changed_at,ip_key)
     VALUES (?,?,?,?,1,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(id, type, group, 'approved', JSON.stringify({ v: 1, supportIndex: null, heroes: [{ stockId: 1 }], ...payload }), JSON.stringify(tags), 'en', 'e', '<p>e</p>', '', 1000, 1000, 1000, 'k')
    .run()
}

interface Row {
  id: string
  group_id: string
  tags: string
  payload: string
  version: number
  updated_at: number
  title: string
}
const get = async (id: string) => (await env.DB.prepare('SELECT * FROM submission_tab WHERE id = ?').bind(id).first<Row>())!
const audits = async () => (await env.DB.prepare("SELECT * FROM audit_log_tab WHERE action = 'data.migrate'").all<{ actor: string; type: string; detail: string }>()).results

beforeEach(async () => {
  await resetState()
  await env.DB.prepare('DELETE FROM audit_log_tab').run()
})

describe('2026-10-team-creator.sql', () => {
  it('parses into the expected statements', () => {
    expect(statements).toHaveLength(2)
    expect(statements[0]).toMatch(/^INSERT INTO audit_log_tab/)
    expect(statements[1]).toMatch(/^UPDATE submission_tab/)
  })

  it('moves every row to `all`, maps rng to successRate, adds teamType and the simulator target', async () => {
    await seed('none', 'hero-10251', { rng: 'none' })
    await seed('few', 'sidekick-20011', { rng: 'few' })
    await seed('many', 'quest-206002', { rng: 'many' })
    await seed('imp', 'event-2607', { rng: 'impractical' })
    await seed('sim1', 'quest-616001', { rng: 'few' })
    await seed('sim2', 'quest-617001', { rng: 'none' })
    await seed('sim3', 'quest-618001', { rng: 'many' })
    await seed('already', 'all', { teamType: 'auto', successRate: 'low' })
    await env.DB.prepare('INSERT INTO submission_type_tab (id,name,enabled,allowed_origins,plugin_url,groups_url,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind('some-other-type', 'Other', 1, '[]', 'https://x/p.js', 'https://x/g.json', 1)
      .run()
    await seed('other', 'quest-1', { rng: 'none' }, {}, 'some-other-type')

    await runScript()

    const expectRow = async (id: string, tags: Record<string, string>, target?: string) => {
      const r = await get(id)
      expect(r.group_id, id).toBe('all')
      expect(JSON.parse(r.tags), id).toEqual(tags)
      const p = JSON.parse(r.payload)
      expect(p.target, id).toBe(target)
      expect(p.heroes, id).toEqual([{ stockId: 1 }])
      expect(r.version, id).toBe(2)
      expect(r.updated_at, id).toBeGreaterThan(1000)
      expect(r.title, id).toBe('')
    }
    await expectRow('none', { teamType: 'manual', successRate: 'high' })
    await expectRow('few', { teamType: 'manual', successRate: 'high' })
    await expectRow('many', { teamType: 'manual', successRate: 'medium' })
    await expectRow('imp', { teamType: 'manual', successRate: 'low' })
    await expectRow('sim1', { teamType: 'manual', successRate: 'high' }, 'quest-616001')
    await expectRow('sim2', { teamType: 'manual', successRate: 'high' }, 'quest-617001')
    await expectRow('sim3', { teamType: 'manual', successRate: 'medium' }, 'quest-618001')

    // Rows that are already migrated, and rows of other types, are not touched.
    const already = await get('already')
    expect(already).toMatchObject({ group_id: 'all', version: 1, updated_at: 1000 })
    expect(JSON.parse(already.tags)).toEqual({ teamType: 'auto', successRate: 'low' })
    const other = await get('other')
    expect(other).toMatchObject({ group_id: 'quest-1', version: 1 })
    expect(JSON.parse(other.tags)).toEqual({ rng: 'none' })

    const a = await audits()
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ actor: 'cli', type: TYPE })
    expect(JSON.parse(a[0]!.detail)).toEqual({ script: '2026-10-team-creator', rows: 7 })
  })

  it('is idempotent: a second run changes nothing and writes no audit row, a later straggler is swept', async () => {
    await seed('a', 'quest-616001', { rng: 'few' })
    await runScript()
    const first = await get('a')
    await runScript()
    expect(await get('a')).toEqual(first)
    expect(await audits()).toHaveLength(1)

    // A row that arrived in an old group during the deploy gap (already on the new tags) is moved by the next run.
    await seed('late', 'hero-1', { teamType: 'auto', successRate: 'high' })
    await runScript()
    expect(await get('late')).toMatchObject({ group_id: 'all', version: 2 })
    expect(JSON.parse((await get('late')).tags)).toEqual({ teamType: 'auto', successRate: 'high' })
    expect(await get('a')).toEqual(first)
    const a = await audits()
    expect(a).toHaveLength(2)
    expect(JSON.parse(a[1]!.detail).rows).toBe(1)
  })

  it('does nothing (and audits nothing) on an empty table', async () => {
    await runScript()
    expect(await audits()).toHaveLength(0)
  })

  it('tolerates a row with no recognisable tags', async () => {
    await seed('odd', 'quest-1', {})
    await runScript()
    expect(JSON.parse((await get('odd')).tags)).toEqual({ teamType: 'manual', successRate: 'medium' })
  })
})
