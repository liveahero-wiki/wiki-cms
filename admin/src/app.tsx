import { useEffect, useRef } from 'preact/hooks'
import type { MeResponse } from '../../src/shared/api-types.ts'
import { CenterShell, Layout } from './components/Layout.tsx'
import { ErrorBox, Skeleton, lazyPage } from './components/ui.tsx'
import { InvitePage, LoginPage } from './pages/Auth.tsx'
import { HomePage } from './pages/Home.tsx'
import { TypePage } from './pages/TypePages.tsx'
import { Link, navigate, safeNext, useLocation } from './router.tsx'
import { refreshSession, useSession } from './session.ts'
import { Toasts } from './toast.tsx'

// Rarely used pages are split into their own chunks.
const InvitesPage = lazyPage<{ me: MeResponse }>(() => import('./pages/Invites.tsx'))
const ModeratorsPage = lazyPage<object>(() => import('./pages/Moderators.tsx'))
const IpBlocksPage = lazyPage<object>(() => import('./pages/IpBlocks.tsx'))
const AuditPage = lazyPage<{ me: MeResponse }>(() => import('./pages/Audit.tsx'))

function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to])
  return null
}

function NotFound() {
  return (
    <section class="panel center-panel">
      <h1>Page not found</h1>
      <p>
        <Link href="/">Back to the portal</Link>
      </p>
    </section>
  )
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function Routes({ me, path }: { me: MeResponse; path: string }) {
  let m: RegExpMatchArray | null
  if (path === '/') return <HomePage me={me} />
  if (path === '/invites') return <InvitesPage me={me} />
  if (path === '/moderators') return <ModeratorsPage />
  if (path === '/ip-blocks') return <IpBlocksPage />
  if (path === '/audit') return <AuditPage me={me} />
  if ((m = path.match(/^\/invite\/([^/]+)$/))) return <InvitePage key={m[1]} token={decode(m[1]!)} />
  if ((m = path.match(/^\/t\/([^/]+)\/g\/([^/]+)\/?$/))) return <TypePage me={me} typeId={decode(m[1]!)} groupId={decode(m[2]!)} />
  if ((m = path.match(/^\/t\/([^/]+)\/?$/))) return <TypePage me={me} typeId={decode(m[1]!)} />
  return <NotFound />
}

export function App() {
  const session = useSession()
  const { path, search } = useLocation()

  useEffect(() => {
    void refreshSession()
  }, [])

  // Keyboard/screen-reader users land on the new page's content after navigation.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    document.getElementById('main')?.focus({ preventScroll: true })
  }, [path])

  let body
  if (session.status === 'loading') {
    body = (
      <CenterShell>
        <Skeleton lines={4} />
      </CenterShell>
    )
  } else if (session.status === 'error') {
    body = (
      <CenterShell>
        <ErrorBox message={session.message} onRetry={() => void refreshSession()} />
      </CenterShell>
    )
  } else if (session.status === 'out') {
    const invite = path.match(/^\/invite\/([^/]+)$/)
    if (path === '/login') {
      body = (
        <CenterShell>
          <LoginPage />
        </CenterShell>
      )
    } else if (invite) {
      body = (
        <CenterShell>
          <InvitePage key={invite[1]} token={decode(invite[1]!)} />
        </CenterShell>
      )
    } else {
      body = <Redirect to={`/login?next=${encodeURIComponent(path + search)}`} />
    }
  } else if (path === '/login') {
    body = <Redirect to={safeNext(new URLSearchParams(search).get('next'))} />
  } else {
    body = (
      <Layout me={session.me}>
        <Routes me={session.me} path={path} />
      </Layout>
    )
  }
  return (
    <>
      {body}
      <Toasts />
    </>
  )
}
