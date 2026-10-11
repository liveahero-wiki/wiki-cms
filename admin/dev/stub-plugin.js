// Dev-only stand-in for the real game plugin (SubmissionPlugin, apiVersion 1). Plain DOM, no dependencies.
const slotLabel = (s, i, payload) => {
  const support = payload.supportIndex === i
  const el = document.createElement('li')
  el.textContent = `#${i + 1} hero ${s.stockId}` + (s.active ? ` + active ${s.active}` : '') + (support ? ' (support)' : '')
  el.style.cssText = `padding:2px 8px;border-radius:6px;border:1px solid var(--cms-border,#8884);${support ? 'background:var(--cms-support-bg,#d9f4f7);' : ''}`
  return el
}

function list(payload) {
  const ul = document.createElement('ul')
  ul.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;list-style:none;margin:0;padding:0'
  for (const [i, s] of (payload?.heroes ?? []).entries()) ul.append(slotLabel(s, i, payload))
  return ul
}

export default {
  apiVersion: 1,
  type: 'lah-team-formation',
  defaultPayload: () => ({ v: 1, supportIndex: null, heroes: [{ stockId: 10011 }] }),

  mountSummary(el, payload, ctx) {
    const box = document.createElement('div')
    box.dataset.stub = 'summary'
    box.append(list(payload))
    const note = document.createElement('small')
    note.textContent = `stub summary - group ${ctx.group.id}, theme ${ctx.theme}`
    note.style.color = 'var(--cms-muted,#888)'
    box.append(note)
    el.append(box)
    return () => box.remove()
  },

  mountDetail(el, payload) {
    const box = document.createElement('div')
    box.dataset.stub = 'detail'
    const pre = document.createElement('pre')
    pre.textContent = JSON.stringify(payload, null, 2)
    pre.style.cssText = 'margin:8px 0 0;overflow:auto;max-width:100%'
    box.append(list(payload), pre)
    el.append(box)
    return () => box.remove()
  },

  mountEditor(el, init, ctx) {
    const box = document.createElement('div')
    box.dataset.stub = 'editor'
    const note = document.createElement('p')
    note.style.cssText = 'margin:0 0 6px;font-size:.85em'
    note.textContent =
      ctx.group.options.support === false
        ? 'This group does not allow a borrowed support (supportIndex must be null).'
        : 'This group requires exactly one borrowed support slot (set supportIndex).'
    const ta = document.createElement('textarea')
    ta.rows = 10
    ta.setAttribute('aria-label', 'Team payload JSON')
    ta.style.cssText = 'width:100%;box-sizing:border-box;font-family:monospace'
    ta.value = JSON.stringify(init.value, null, 2)
    const err = document.createElement('ul')
    err.setAttribute('role', 'alert')
    err.style.cssText = 'color:#c0392b;margin:6px 0 0;padding-left:18px'
    const showErrors = (errors) => {
      err.replaceChildren(...errors.map((e) => Object.assign(document.createElement('li'), { textContent: `${e.path}: ${e.message}` })))
    }
    ta.addEventListener('input', () => {
      try {
        init.onChange(JSON.parse(ta.value))
        ta.removeAttribute('aria-invalid')
      } catch {
        ta.setAttribute('aria-invalid', 'true')
      }
    })
    showErrors(init.errors ?? [])
    box.append(note, ta, err)
    el.append(box)
    return {
      destroy: () => box.remove(),
      validate() {
        try {
          JSON.parse(ta.value)
          return []
        } catch {
          return [{ path: 'payload', code: 'payload_invalid', message: 'Not valid JSON.' }]
        }
      },
      setErrors: showErrors,
    }
  },
}
