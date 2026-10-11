import { useEffect, useState } from 'preact/hooks'

type Kind = 'info' | 'warn' | 'error'
interface Toast {
  id: number
  kind: Kind
  text: string
}

let toasts: Toast[] = []
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

/** Warnings/errors stay until dismissed; info disappears after a few seconds. */
export function toast(text: string, kind: Kind = 'info') {
  const id = nextId++
  toasts = [...toasts, { id, kind, text }]
  emit()
  if (kind === 'info') setTimeout(() => dismissToast(id), 4000)
}

export function Toasts() {
  const [, bump] = useState(0)
  useEffect(() => {
    const l = () => bump((n) => n + 1)
    listeners.add(l)
    return () => void listeners.delete(l)
  }, [])
  return (
    <div class="toasts" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <div key={t.id} class={`toast toast-${t.kind}`} role={t.kind === 'info' ? 'status' : 'alert'}>
          <span>{t.text}</span>
          <button type="button" class="btn-icon" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
