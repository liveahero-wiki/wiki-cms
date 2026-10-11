import { useEffect } from 'preact/hooks'
import type { MeResponse } from '../../../src/shared/api-types.ts'
import { useTitle } from '../hooks.ts'
import { navigate, typePath } from '../router.tsx'

export function HomePage({ me }: { me: MeResponse }) {
  useTitle('Home')
  const first = me.types.find((t) => t.enabled) ?? me.types[0]
  useEffect(() => {
    if (first) navigate(typePath(first.id), { replace: true })
  }, [first?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (first) return null
  return (
    <section class="panel center-panel">
      <h1>No moderator permissions yet</h1>
      <p>
        You are signed in as <strong>{me.user.name}</strong>, but this account has not been granted access to any submission type.
      </p>
      <ul>
        <li>Ask an existing moderator to send you an invite link (Invites page), then open it while signed in.</li>
        <li>
          Or ask the site owner to grant access from the CLI with your user id: <code>{me.user.id}</code>
        </li>
      </ul>
    </section>
  )
}
