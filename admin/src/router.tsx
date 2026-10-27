import type { ComponentChildren, JSX } from 'preact'
import { useEffect, useState } from 'preact/hooks'

export interface Loc {
  path: string
  search: string
}

const read = (): Loc => ({ path: location.pathname, search: location.search })
let current = read()
const listeners = new Set<() => void>()
const emit = () => {
  current = read()
  listeners.forEach((l) => l())
}
window.addEventListener('popstate', emit)

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (to === location.pathname + location.search) return
  if (opts.replace) history.replaceState(null, '', to)
  else {
    history.pushState(null, '', to)
    window.scrollTo(0, 0)
  }
  emit()
}

export function useLocation(): Loc {
  const [loc, setLoc] = useState(current)
  useEffect(() => {
    const l = () => setLoc(current)
    listeners.add(l)
    l()
    return () => void listeners.delete(l)
  }, [])
  return loc
}

/** Same-origin, absolute-path-only redirect targets (open-redirect guard for `?next=`). */
export const safeNext = (v: string | null): string => (v && /^\/(?!\/|\\)/.test(v) ? v : '/')

type LinkProps = Omit<JSX.HTMLAttributes<HTMLAnchorElement>, 'href'> & { href: string; target?: string; children?: ComponentChildren }

export function Link({ href, onClick, children, ...rest }: LinkProps) {
  return (
    <a
      href={href}
      {...rest}
      onClick={(e) => {
        onClick?.(e)
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        if (rest.target && rest.target !== '_self') return
        e.preventDefault()
        navigate(href)
      }}
    >
      {children}
    </a>
  )
}

export const typePath = (type: string) => `/t/${encodeURIComponent(type)}`

/**
 * Url of a view on a type page. The default view (pending submissions, every group) is the bare
 * type path; a group only appears in the url once a type has more than one.
 */
export function viewPath(
  type: string,
  opts: { state?: 'pending' | 'approved' | 'spam'; tab?: 'edits'; edits?: string; group?: string } = {},
): string {
  const qs = new URLSearchParams()
  if (opts.tab === 'edits') {
    qs.set('tab', 'edits')
    if (opts.edits && opts.edits !== 'pending') qs.set('edits', opts.edits)
  } else if (opts.state && opts.state !== 'pending') qs.set('state', opts.state)
  if (opts.group) qs.set('group', opts.group)
  const s = qs.toString()
  return s ? `${typePath(type)}?${s}` : typePath(type)
}
