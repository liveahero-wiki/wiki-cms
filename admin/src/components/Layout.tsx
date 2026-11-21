import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { MeResponse } from '../../../src/shared/api-types.ts'
import { Link, typePath, useLocation } from '../router.tsx'
import { signOut } from '../session.ts'
import { setThemePref, useTheme, type ThemePref } from '../theme.ts'

function UserMenu({ me }: { me: MeResponse }) {
  const ref = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const close = (e: Event) => {
      const d = ref.current
      if (d?.open && !d.contains(e.target as Node)) d.open = false
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && ref.current?.open) {
        ref.current.open = false
        ref.current.querySelector('summary')?.focus()
      }
    }
    document.addEventListener('click', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', esc)
    }
  }, [])
  return (
    <details class="user-menu" ref={ref}>
      <summary>
        {me.user.image ? <img class="avatar" src={me.user.image} alt="" width="24" height="24" referrerpolicy="no-referrer" /> : <span class="avatar avatar-fallback" aria-hidden="true" />}
        <span class="user-name">{me.user.name}</span>
      </summary>
      <div class="menu-panel">
        <p class="menu-id">
          Signed in as <strong>{me.user.name}</strong>
          <br />
          <code>{me.user.id}</code>
        </p>
        <button type="button" class="btn btn-block" onClick={() => signOut()}>
          Sign out
        </button>
      </div>
    </details>
  )
}

export function ThemeSelect() {
  const { pref } = useTheme()
  return (
    <label class="theme-select">
      <span class="visually-hidden">Theme</span>
      <select class="input input-small" value={pref} onChange={(e) => setThemePref(e.currentTarget.value as ThemePref)}>
        <option value="auto">Theme: auto</option>
        <option value="light">Theme: light</option>
        <option value="dark">Theme: dark</option>
      </select>
    </label>
  )
}

function NavLink({ href, active, children }: { href: string; active: boolean; children: ComponentChildren }) {
  return (
    <Link href={href} class="nav-link" aria-current={active ? 'page' : undefined}>
      {children}
    </Link>
  )
}

/** Pending count; `alert` colours it like a warn badge (contributor edits waiting for review). */
function NavCount({ n, alert, title }: { n: number; alert?: boolean; title: string }) {
  if (!n) return null
  return (
    <span class={`tab-count${alert ? ' tab-count-alert' : ''}`} title={title}>
      {n}
    </span>
  )
}

function Sidebar({ me, path, search }: { me: MeResponse; path: string; search: string }) {
  const tab = new URLSearchParams(search).get('tab')
  return (
    <nav class="sidebar" aria-label="Main">
      <h2 class="nav-heading">Submission types</h2>
      <ul class="nav-list">
        {me.types.map((t) => {
          const base = typePath(t.id)
          const inType = path === base || path.startsWith(`${base}/`)
          const onSubmissions = path === base && tab !== 'edits'
          return (
            <li key={t.id}>
              <NavLink href={base} active={inType && onSubmissions}>
                <span class="nav-name">{t.name}</span>
                {!t.enabled && <span class="nav-tag">disabled</span>}
                {/* The sub-links carry the same numbers once the type is open. */}
                {!inType && (
                  <span class="nav-counts">
                    <NavCount n={t.pendingSubmissions} title={`${t.pendingSubmissions} pending submissions`} />
                    <NavCount n={t.pendingEdits} alert title={`${t.pendingEdits} contributor edits waiting for review`} />
                  </span>
                )}
              </NavLink>
              {inType && (
                <ul class="nav-sub">
                  <li>
                    <NavLink href={base} active={onSubmissions}>
                      <span class="nav-name">Submissions</span>
                      <NavCount n={t.pendingSubmissions} title={`${t.pendingSubmissions} pending submissions`} />
                    </NavLink>
                  </li>
                  <li>
                    <NavLink href={`${base}?tab=edits`} active={path === base && tab === 'edits'}>
                      <span class="nav-name">Contributor edits</span>
                      <NavCount n={t.pendingEdits} alert title={`${t.pendingEdits} contributor edits waiting for review`} />
                    </NavLink>
                  </li>
                </ul>
              )}
            </li>
          )
        })}
      </ul>
      <h2 class="nav-heading">Team</h2>
      <ul class="nav-list">
        <li>
          <NavLink href="/invites" active={path === '/invites'}>
            Invites
          </NavLink>
        </li>
        <li>
          <NavLink href="/moderators" active={path === '/moderators'}>
            Moderators
          </NavLink>
        </li>
        <li>
          <NavLink href="/ip-blocks" active={path === '/ip-blocks'}>
            IP blocks
          </NavLink>
        </li>
        <li>
          <NavLink href="/audit" active={path === '/audit'}>
            Audit log
          </NavLink>
        </li>
      </ul>
    </nav>
  )
}

/** Keep in sync with the `@media (max-width: 900px)` sidebar rule in styles.css. */
const NARROW_QUERY = '(max-width: 900px)'

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY)
    const update = () => setNarrow(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return narrow
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  )
}

export function Layout({ me, children }: { me: MeResponse; children: ComponentChildren }) {
  const { path, search } = useLocation()
  const [open, setOpen] = useState(false)
  const narrow = useNarrow()
  const wrapRef = useRef<HTMLDivElement>(null)
  // The sidebar is a plain column on wide screens. On narrow ones it becomes an
  // auto popover (top layer, backdrop, light dismiss, Escape, focus restore).
  // Links inside do not dismiss it, so close it when the route changes.
  useEffect(() => {
    const el = wrapRef.current
    if (el?.matches(':popover-open')) el.hidePopover()
  }, [path, search])
  const hasTypes = me.types.length > 0
  return (
    <div class="app">
      <a class="skip-link" href="#main">
        Skip to content
      </a>
      <header class="topbar">
        {hasTypes && (
          <button type="button" class="btn nav-toggle" aria-label="Menu" aria-expanded={open} aria-controls="sidebar-wrap" popovertarget="sidebar-wrap">
            <MenuIcon />
          </button>
        )}
        <Link href="/" class="brand">
          Wiki CMS
        </Link>
        <span class="spacer" />
        <ThemeSelect />
        <UserMenu me={me} />
      </header>
      <div class={`shell${hasTypes ? '' : ' shell-single'}`}>
        {hasTypes && (
          <div
            id="sidebar-wrap"
            class="sidebar-wrap"
            ref={wrapRef}
            popover={narrow ? 'auto' : undefined}
            onToggle={(e) => setOpen(e.currentTarget.matches(':popover-open'))}
          >
            <Sidebar me={me} path={path} search={search} />
          </div>
        )}
        <main id="main" class="main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  )
}

/** Minimal centered shell for signed-out pages (login, invite). */
export function CenterShell({ children }: { children: ComponentChildren }) {
  return (
    <div class="app">
      <header class="topbar">
        <span class="brand">Wiki CMS</span>
        <span class="spacer" />
        <ThemeSelect />
      </header>
      <main id="main" class="center-main" tabIndex={-1}>
        {children}
      </main>
    </div>
  )
}
