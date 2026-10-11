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
export const groupPath = (type: string, group: string) => `${typePath(type)}/g/${encodeURIComponent(group)}`
