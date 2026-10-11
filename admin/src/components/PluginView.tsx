import { useEffect, useRef, useState } from 'preact/hooks'
import type { PluginContext, SubmissionPlugin } from '../../../src/shared/plugin-api.ts'

export function RawPayload({ payload, reason }: { payload: unknown; reason?: string }) {
  return (
    <div class="raw-payload">
      {reason && <p class="raw-warning">Plugin view unavailable ({reason}); showing the raw payload.</p>}
      <pre class="raw-json">{JSON.stringify(payload, null, 2)}</pre>
    </div>
  )
}

interface Props {
  kind: 'summary' | 'detail'
  plugin: SubmissionPlugin
  payload: unknown
  ctx: PluginContext
}

/** Mounts a plugin view into a div and cleans it up; a throwing plugin degrades to raw JSON. */
export function PluginView({ kind, plugin, payload, ctx }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const payloadKey = JSON.stringify(payload)
  const optionsKey = JSON.stringify(ctx.group)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    setFailed(null)
    let cleanup: (() => void) | undefined
    try {
      cleanup = kind === 'summary' ? plugin.mountSummary(el, payload, ctxRef.current) : plugin.mountDetail(el, payload, ctxRef.current)
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e))
      return
    }
    return () => {
      try {
        cleanup?.()
      } catch {
        /* a failing cleanup must not break the portal */
      }
      el.replaceChildren()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin, kind, payloadKey, optionsKey])

  if (failed) return <RawPayload payload={payload} reason={failed} />
  return <div class="plugin-view" ref={ref} />
}
