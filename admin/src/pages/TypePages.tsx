import { useMemo, useState } from 'preact/hooks'
import type { AdminGroup, MeResponse, SubmissionState } from '../../../src/shared/api-types.ts'
import { Breadcrumbs, Empty, ErrorBox, Notice, Skeleton, TabLinks } from '../components/ui.tsx'
import { RevisionList, type RevisionState } from '../components/RevisionList.tsx'
import { SubmissionList } from '../components/SubmissionList.tsx'
import { formatAbsolute, formatRelative } from '../format.ts'
import { useTitle } from '../hooks.ts'
import { Link, groupPath, typePath, useLocation } from '../router.tsx'
import { TypeProvider, groupOf, useTypeData } from '../typeData.tsx'

type TypeInfo = MeResponse['types'][number]

function wikiHref(info: TypeInfo, url: string | null): string | null {
  if (!url) return null
  try {
    // Registry urls are wiki-relative; the plugin lives on the wiki, so resolve against its URL.
    return new URL(url, info.pluginUrl).href
  } catch {
    return null
  }
}

function GroupsTable() {
  const td = useTypeData()
  const [q, setQ] = useState('')
  const [empty, setEmpty] = useState(false)
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (td.groups ?? []).filter((g) => {
      if (!empty && g.pending + g.approved + g.spam === 0) return false
      return !needle || g.title.toLowerCase().includes(needle) || g.groupId.toLowerCase().includes(needle)
    })
  }, [td.groups, q, empty])

  if (td.groupsError) return <ErrorBox message={td.groupsError} onRetry={td.reloadGroups} />
  if (!td.groups) return <Skeleton lines={6} height="1.4em" />
  const total = td.groups.length
  return (
    <>
      <div class="toolbar">
        <label class="field field-inline">
          <span class="field-label">Filter groups</span>
          <input class="input" type="search" placeholder="Title or id" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
        </label>
        <label class="check">
          <input type="checkbox" checked={empty} onChange={(e) => setEmpty(e.currentTarget.checked)} />
          <span>Include groups without submissions ({total - td.groups.filter((g) => g.pending + g.approved + g.spam > 0).length})</span>
        </label>
      </div>
      {groups.length === 0 ? (
        <Empty>{td.groups.some((g) => g.pending + g.approved + g.spam > 0) || empty ? 'No groups match.' : 'No submissions yet.'}</Empty>
      ) : (
        <ul class="group-list">
          {groups.map((g) => (
            <GroupRow key={g.groupId} g={g} info={td.info} />
          ))}
        </ul>
      )}
    </>
  )
}

function GroupRow({ g, info }: { g: AdminGroup; info: TypeInfo }) {
  const href = wikiHref(info, g.url)
  return (
    <li class="group-row">
      <div class="group-main">
        <Link class="group-title" href={groupPath(info.id, g.groupId)}>
          {g.title}
        </Link>
        <span class="group-id">
          <code>{g.groupId}</code>
          {!g.inRegistry && <span class="nav-tag" title="Not in the wiki's groups registry (any more)">not in registry</span>}
          {href && (
            <>
              {' · '}
              <a href={href} target="_blank" rel="noopener noreferrer">
                Wiki page ↗
              </a>
            </>
          )}
        </span>
      </div>
      <dl class="counts">
        <div class={g.pending ? 'count-pending' : ''}>
          <dt>Pending</dt>
          <dd>{g.pending}</dd>
        </div>
        <div>
          <dt>Approved</dt>
          <dd>{g.approved}</dd>
        </div>
        <div>
          <dt>Spam</dt>
          <dd>{g.spam}</dd>
        </div>
      </dl>
      <span class="group-latest">{g.latestAt ? <time title={formatAbsolute(g.latestAt)}>{formatRelative(g.latestAt)}</time> : '—'}</span>
    </li>
  )
}

const REVISION_STATES: { state: RevisionState; label: string }[] = [
  { state: 'pending', label: 'Pending' },
  { state: 'approved', label: 'Approved' },
  { state: 'rejected', label: 'Rejected' },
  { state: 'withdrawn', label: 'Withdrawn' },
]

function TypeView({ info }: { info: TypeInfo }) {
  const { search } = useLocation()
  const params = new URLSearchParams(search)
  const view = params.get('tab') === 'queue' ? 'queue' : params.get('tab') === 'edits' ? 'edits' : 'groups'
  const rawEdits = params.get('edits')
  const editState: RevisionState = REVISION_STATES.find((s) => s.state === rawEdits)?.state ?? 'pending'
  const viewLabel = { queue: 'Pending queue', edits: 'Contributor edits', groups: 'Groups' }[view]
  useTitle(viewLabel, info.name)
  const td = useTypeData()
  const pending = td.groups?.reduce((n, g) => n + g.pending, 0)
  const base = typePath(info.id)
  return (
    <>
      <Breadcrumbs items={[{ label: info.name, href: base }, { label: viewLabel }]} />
      <h1>{info.name}</h1>
      {!info.enabled && <Notice kind="warn">This type is disabled; it cannot be used until it is re-enabled with the CLI.</Notice>}
      <TabLinks
        label="Views"
        tabs={[
          { href: base, label: 'Groups', active: view === 'groups' },
          { href: `${base}?tab=queue`, label: <>Pending queue{pending !== undefined && <span class="tab-count">{pending}</span>}</>, active: view === 'queue' },
          { href: `${base}?tab=edits`, label: 'Contributor edits', active: view === 'edits' },
        ]}
      />
      {view === 'edits' && (
        <TabLinks
          label="Edit state"
          tabs={REVISION_STATES.map((s) => ({
            href: s.state === 'pending' ? `${base}?tab=edits` : `${base}?tab=edits&edits=${s.state}`,
            label: s.label,
            active: s.state === editState,
          }))}
        />
      )}
      {view === 'queue' ? <SubmissionList typeId={info.id} state="pending" /> : view === 'edits' ? <RevisionList typeId={info.id} state={editState} /> : <GroupsTable />}
    </>
  )
}

const STATES: { state: SubmissionState; label: string }[] = [
  { state: 'pending', label: 'Pending' },
  { state: 'approved', label: 'Approved' },
  { state: 'spam', label: 'Spam' },
]

function GroupView({ info, groupId }: { info: TypeInfo; groupId: string }) {
  const td = useTypeData()
  const { search } = useLocation()
  const raw = new URLSearchParams(search).get('state')
  const state: SubmissionState = raw === 'approved' || raw === 'spam' ? raw : 'pending'
  const g = groupOf(td, groupId)
  const title = g?.title ?? groupId
  useTitle(title, info.name)
  const href = g ? wikiHref(info, g.url) : null
  const base = groupPath(info.id, groupId)
  return (
    <>
      <Breadcrumbs items={[{ label: info.name, href: typePath(info.id) }, { label: 'Groups', href: typePath(info.id) }, { label: title }]} />
      <h1>{title}</h1>
      <p class="hint">
        <code>{groupId}</code>
        {g && !g.inRegistry && ' · not in the wiki groups registry'}
        {href && (
          <>
            {' · '}
            <a href={href} target="_blank" rel="noopener noreferrer">
              Wiki page ↗
            </a>
          </>
        )}
      </p>
      <TabLinks
        label="Submission state"
        tabs={STATES.map((s) => ({
          href: s.state === 'pending' ? base : `${base}?state=${s.state}`,
          label: (
            <>
              {s.label}
              {g && <span class="tab-count">{g[s.state]}</span>}
            </>
          ),
          active: s.state === state,
        }))}
      />
      <SubmissionList typeId={info.id} groupId={groupId} state={state} />
    </>
  )
}

export function TypePage({ me, typeId, groupId }: { me: MeResponse; typeId: string; groupId?: string }) {
  const info = me.types.find((t) => t.id === typeId)
  if (!info) {
    return (
      <section class="panel">
        <h1>No access</h1>
        <p>You do not have access to the submission type “{typeId}”, or it does not exist.</p>
        <Link href="/">Back to the portal</Link>
      </section>
    )
  }
  return (
    <TypeProvider key={typeId} info={info}>
      {groupId ? <GroupView info={info} groupId={groupId} /> : <TypeView info={info} />}
    </TypeProvider>
  )
}
