import type { ComponentChildren, JSX } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { Link } from '../router.tsx'

export function Skeleton({ lines = 3, height = '1em' }: { lines?: number; height?: string }) {
  return (
    <div class="skeleton" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} class="skeleton-line" style={{ height, width: i === lines - 1 ? '60%' : '100%' }} />
      ))}
    </div>
  )
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div class="notice notice-error" role="alert">
      <span>{message}</span>
      {onRetry && (
        <button type="button" class="btn btn-small" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  )
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'error'; children: ComponentChildren }) {
  return (
    <div class={`notice notice-${kind}`} role={kind === 'info' ? 'status' : 'alert'}>
      <span>{children}</span>
    </div>
  )
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <p class="empty">{children}</p>
}

export function Badge({ kind = 'neutral', children, title }: { kind?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent'; children: ComponentChildren; title?: string }) {
  return (
    <span class={`badge badge-${kind}`} title={title}>
      {children}
    </span>
  )
}

export interface Crumb {
  label: string
  href?: string
}
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav class="breadcrumbs" aria-label="Breadcrumb">
      <ol>
        {items.map((c, i) => (
          <li key={i} aria-current={i === items.length - 1 ? 'page' : undefined}>
            {c.href && i < items.length - 1 ? <Link href={c.href}>{c.label}</Link> : <span>{c.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  )
}

/** Link-based tab strip (each tab is a real URL). */
export function TabLinks({ label, tabs }: { label: string; tabs: { href: string; label: ComponentChildren; active: boolean }[] }) {
  return (
    <nav class="tabs" aria-label={label}>
      {tabs.map((t, i) => (
        <Link key={i} href={t.href} class="tab" aria-current={t.active ? 'page' : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  )
}

interface DialogProps {
  title: string
  onClose: () => void
  children: ComponentChildren
  wide?: boolean
  /** Return false to veto closing via Esc/backdrop (e.g. unsaved changes). */
  canClose?: () => boolean
  dismissOnBackdrop?: boolean
  labelId?: string
}

/** Modal built on the native <dialog>: focus trap/Esc come from the platform, focus returns to the opener. */
export function Dialog({ title, onClose, children, wide, canClose, dismissOnBackdrop, labelId = 'dlg-title' }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const closing = useRef(false)
  const propsRef = useRef({ onClose, canClose })
  propsRef.current = { onClose, canClose }

  useEffect(() => {
    const d = ref.current!
    const opener = document.activeElement as HTMLElement | null
    d.showModal()
    return () => {
      closing.current = true
      if (d.open) d.close()
      opener?.focus?.()
    }
  }, [])

  const requestClose = () => {
    if (propsRef.current.canClose && !propsRef.current.canClose()) return
    propsRef.current.onClose()
  }

  return (
    <dialog
      ref={ref}
      class={`dialog${wide ? ' dialog-wide' : ''}`}
      aria-labelledby={labelId}
      onCancel={(e: Event) => {
        // Esc: let our own state decide (the dialog unmounts with its owner).
        e.preventDefault()
        requestClose()
      }}
      onClick={(e: JSX.TargetedMouseEvent<HTMLDialogElement>) => {
        if (dismissOnBackdrop && e.target === e.currentTarget) requestClose()
      }}
    >
      <div class="dialog-inner">
        <header class="dialog-head">
          <h2 id={labelId}>{title}</h2>
          <button type="button" class="btn-icon" aria-label="Close" onClick={requestClose}>
            ×
          </button>
        </header>
        {children}
      </div>
    </dialog>
  )
}

/** Loads a page module on demand (code splitting for rarely used pages). */
export function lazyPage<P extends object>(load: () => Promise<{ default: (props: P) => JSX.Element | null }>) {
  let loaded: ((props: P) => JSX.Element | null) | null = null
  return function LazyPage(props: P) {
    const [Page, setPage] = useState<((props: P) => JSX.Element | null) | null>(() => loaded)
    const [error, setError] = useState<string | null>(null)
    useEffect(() => {
      if (loaded) return
      load().then(
        (m) => {
          loaded = m.default
          setPage(() => m.default)
        },
        () => setError('Could not load this page. Reload and try again.'),
      )
    }, [])
    if (error) return <ErrorBox message={error} onRetry={() => location.reload()} />
    return Page ? <Page {...props} /> : <Skeleton lines={4} />
  }
}
