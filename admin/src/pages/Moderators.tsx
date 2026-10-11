import { api, errorMessage } from '../api.ts'
import { Breadcrumbs, Empty, ErrorBox, Notice, Skeleton } from '../components/ui.tsx'
import { useAsync, useTitle } from '../hooks.ts'

interface Moderator {
  id: string
  name: string
  image: string | null
  types: string[]
}

export default function ModeratorsPage() {
  useTitle('Moderators')
  const list = useAsync(() => api.get<{ moderators: Moderator[] }>('/moderators'), [])
  return (
    <>
      <Breadcrumbs items={[{ label: 'Team' }, { label: 'Moderators' }]} />
      <h1>Moderators</h1>
      <Notice>
        This list is read-only. Moderator access is revoked from the command line by the site owner: <code>pnpm cms mod revoke &lt;userId&gt; [--types &lt;type&gt;]</code>.
      </Notice>
      {list.error ? (
        <ErrorBox message={errorMessage(list.error)} onRetry={list.reload} />
      ) : !list.data ? (
        <Skeleton lines={4} />
      ) : list.data.moderators.length === 0 ? (
        <Empty>No moderators.</Empty>
      ) : (
        <ul class="rows">
          {list.data.moderators.map((m) => (
            <li class="row" key={m.id}>
              {m.image ? <img class="avatar" src={m.image} alt="" width="32" height="32" referrerpolicy="no-referrer" /> : <span class="avatar avatar-fallback" aria-hidden="true" />}
              <div class="row-main">
                <strong>{m.name}</strong>
                <div class="hint">
                  Types: {m.types.join(', ')} · id <code>{m.id}</code>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
