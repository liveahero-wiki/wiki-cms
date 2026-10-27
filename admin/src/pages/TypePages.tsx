import type { MeResponse, SubmissionState } from '../../../src/shared/api-types.ts'
import { Breadcrumbs, Notice, TabLinks } from '../components/ui.tsx'
import { RevisionList, type RevisionState } from '../components/RevisionList.tsx'
import { SubmissionList } from '../components/SubmissionList.tsx'
import { useTitle } from '../hooks.ts'
import { Link, typePath, useLocation, viewPath } from '../router.tsx'
import { TypeProvider, groupOf, useTypeData } from '../typeData.tsx'

type TypeInfo = MeResponse['types'][number]

const REVISION_STATES: { state: RevisionState; label: string }[] = [
  { state: 'pending', label: 'Pending' },
  { state: 'approved', label: 'Approved' },
  { state: 'rejected', label: 'Rejected' },
  { state: 'withdrawn', label: 'Withdrawn' },
]

const STATES: { state: SubmissionState; label: string }[] = [
  { state: 'pending', label: 'Pending' },
  { state: 'approved', label: 'Approved' },
  { state: 'spam', label: 'Spam' },
]

function TypeView({ info }: { info: TypeInfo }) {
  const { search } = useLocation()
  const params = new URLSearchParams(search)
  // `tab=queue` is the pre-2026-10 pending queue; it now lands on the default submissions view.
  const edits = params.get('tab') === 'edits'
  const rawState = params.get('state')
  const state: SubmissionState = STATES.find((s) => s.state === rawState)?.state ?? 'pending'
  const rawEdits = params.get('edits')
  const editState: RevisionState = REVISION_STATES.find((s) => s.state === rawEdits)?.state ?? 'pending'
  const group = params.get('group') ?? undefined
  const viewLabel = edits ? 'Contributor edits' : STATES.find((s) => s.state === state)!.label
  useTitle(viewLabel, info.name)
  const td = useTypeData()
  // Scoped to the filtered group when one is picked, so the counts match the list below.
  const scoped = group ? groupOf(td, group) : undefined
  const countOf = (s: SubmissionState): number | undefined =>
    group ? scoped?.[s] : td.groups?.reduce((n, g) => n + g[s], 0)
  return (
    <>
      <Breadcrumbs items={[{ label: info.name, href: typePath(info.id) }, { label: viewLabel }]} />
      <h1>{info.name}</h1>
      {!info.enabled && <Notice kind="warn">This type is disabled; it cannot be used until it is re-enabled with the CLI.</Notice>}
      <TabLinks
        label="Views"
        tabs={[
          ...STATES.map((s) => {
            const n = countOf(s.state)
            return {
              href: viewPath(info.id, { state: s.state, group }),
              label: (
                <>
                  {s.label}
                  {n !== undefined && <span class="tab-count">{n}</span>}
                </>
              ),
              active: !edits && state === s.state,
            }
          }),
          {
            href: viewPath(info.id, { tab: 'edits', group }),
            label: (
              <>
                Contributor edits
                {info.pendingEdits > 0 && <span class="tab-count tab-count-alert">{info.pendingEdits}</span>}
              </>
            ),
            active: edits,
          },
        ]}
      />
      {edits && (
        <TabLinks
          label="Edit state"
          tabs={REVISION_STATES.map((s) => ({
            href: viewPath(info.id, { tab: 'edits', edits: s.state, group }),
            label: s.label,
            active: s.state === editState,
          }))}
        />
      )}
      {edits ? <RevisionList typeId={info.id} state={editState} /> : <SubmissionList typeId={info.id} groupId={group} state={state} />}
    </>
  )
}

export function TypePage({ me, typeId }: { me: MeResponse; typeId: string }) {
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
      <TypeView info={info} />
    </TypeProvider>
  )
}
