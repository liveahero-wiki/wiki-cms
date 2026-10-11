import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

export interface Async<T> {
  data?: T
  error?: unknown
  loading: boolean
  reload: () => void
}

/** Runs `fn` on mount and whenever `deps` change; stale results are ignored. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): Async<T> {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true })
  const [tick, setTick] = useState(0)
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => {
    let live = true
    setState((s) => ({ data: s.data, loading: true }))
    fnRef.current().then(
      (data) => live && setState({ data, loading: false }),
      (error) => live && setState({ error, loading: false }),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  const reload = useCallback(() => setTick((n) => n + 1), [])
  return { ...state, reload }
}

export function setTitle(parts: string[]) {
  document.title = [...parts, 'Wiki CMS'].join(' · ')
}

export function useTitle(...parts: string[]) {
  useEffect(() => setTitle(parts), [parts.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps
}
