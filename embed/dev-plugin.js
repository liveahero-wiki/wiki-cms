// Stub SubmissionPlugin for the embed dev page (see docs/PLUGIN_API.md). Plain DOM, no build step.
const TEXT = {
  en: { heroes: 'Team', support: 'support', close: 'Close', json: 'Team JSON', badJson: 'Invalid JSON.', codes: { unknown_hero: 'Unknown hero {stockId}.', duplicate_hero: 'Slots {slots} use the same hero.' } },
  'zh-Hans': { heroes: '队伍', support: '支援', close: '关闭', json: '队伍 JSON', badJson: 'JSON 无效。', codes: { unknown_hero: '未知英雄 {stockId}。', duplicate_hero: '第 {slots} 栏使用了相同的英雄。' } },
  'zh-Hant': { heroes: '隊伍', support: '支援', close: '關閉', json: '隊伍 JSON', badJson: 'JSON 無效。', codes: { unknown_hero: '未知英雄 {stockId}。', duplicate_hero: '第 {slots} 欄使用了相同的英雄。' } },
  ja: { heroes: '編成', support: 'サポート', close: '閉じる', json: '編成 JSON', badJson: 'JSON が不正です。', codes: { unknown_hero: '不明なヒーロー {stockId}。', duplicate_hero: 'スロット {slots} で同じヒーローが重複しています。' } },
}
const tx = (lang) => TEXT[lang] ?? TEXT.en

function injectCss() {
  if (document.getElementById('cms-plugin-lah-team-formation')) return
  const s = document.createElement('style')
  s.id = 'cms-plugin-lah-team-formation'
  s.textContent = `
    .devp-summary{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;width:100%;padding:.4rem;border:1px dashed var(--cms-border,#8884);border-radius:6px;background:none;color:inherit;font:inherit;cursor:pointer;text-align:start;min-height:44px}
    .devp-slot{padding:.2rem .6rem;border-radius:6px;background:var(--cms-chip-bg,#8882)}
    .devp-slot.devp-support{background:var(--cms-support-bg,#d9f4f7)}
    .devp-dialog{max-width:min(520px,calc(100vw - 16px));border:1px solid var(--cms-border,#8884);border-radius:8px;background:var(--cms-bg,Canvas);color:var(--cms-fg,CanvasText)}
    .devp-dialog pre{overflow:auto;max-height:50vh}
    .devp-editor textarea{width:100%;min-height:8rem;font:12px/1.4 ui-monospace,Consolas,monospace;background:var(--cms-bg,Canvas);color:var(--cms-fg,CanvasText);border:1px solid var(--cms-border,#8884);border-radius:6px;padding:.4rem}
    .devp-editor textarea[aria-invalid=true]{border-color:#c62828}
    .devp-err{color:#c62828;margin:.2rem 0 0;font-size:.9em}
  `
  document.head.appendChild(s)
}

function chips(el, payload, ctx) {
  const supportOn = ctx.group.options.support !== false
  for (const [i, h] of (payload?.heroes ?? []).entries()) {
    const c = document.createElement('span')
    c.className = 'devp-slot' + (supportOn && payload.supportIndex === i ? ' devp-support' : '')
    c.textContent = `#${h.stockId}` + (h.active ? ` +${h.active}` : '')
    el.appendChild(c)
  }
}

const plugin = {
  apiVersion: 1,
  type: 'lah-team-formation',
  defaultPayload: () => ({ v: 1, supportIndex: null, heroes: [{ stockId: 10011 }] }),

  mountSummary(el, payload, ctx) {
    injectCss()
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'devp-summary'
    btn.setAttribute('aria-haspopup', 'dialog')
    chips(btn, payload, ctx)
    let dialog = null
    btn.onclick = () => {
      dialog = document.createElement('dialog')
      dialog.className = 'devp-dialog'
      const detailHost = document.createElement('div')
      const close = document.createElement('button')
      close.type = 'button'
      close.textContent = tx(ctx.uiLang).close
      close.onclick = () => dialog.close()
      dialog.append(detailHost, close)
      dialog.addEventListener('close', () => { stopDetail(); dialog.remove(); dialog = null })
      const stopDetail = plugin.mountDetail(detailHost, payload, ctx)
      el.appendChild(dialog) // inside the host element so theme variables inherit
      dialog.showModal()
    }
    el.appendChild(btn)
    return () => {
      dialog?.close()
      btn.remove()
    }
  },

  mountDetail(el, payload, ctx) {
    injectCss()
    const h = document.createElement('h3')
    h.textContent = tx(ctx.uiLang).heroes
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:.4rem'
    chips(row, payload, ctx)
    const pre = document.createElement('pre')
    pre.textContent = JSON.stringify(payload, null, 2)
    el.append(h, row, pre)
    return () => el.replaceChildren()
  },

  mountEditor(el, init, ctx) {
    injectCss()
    const L = tx(ctx.uiLang)
    const wrap = document.createElement('div')
    wrap.className = 'devp-editor'
    const label = document.createElement('label')
    label.textContent = L.json + (ctx.group.options.support === false ? ' (no support)' : ' (support allowed)')
    const ta = document.createElement('textarea')
    ta.value = JSON.stringify(init.value, null, 2)
    ta.spellcheck = false
    const msgs = document.createElement('div')
    label.appendChild(ta)
    label.style.display = 'block'
    wrap.append(label, msgs)
    el.appendChild(wrap)

    let parsed = init.value
    let ok = true
    const render = (errors) => {
      ta.setAttribute('aria-invalid', errors.length ? 'true' : 'false')
      msgs.replaceChildren(
        ...errors.map((e) => {
          const p = document.createElement('p')
          p.className = 'devp-err'
          const tpl = L.codes[e.code]
          p.textContent = tpl ? tpl.replace(/\{(\w+)\}/g, (m, k) => e.params?.[k] ?? m) : e.message
          return p
        }),
      )
    }
    ta.addEventListener('input', () => {
      try {
        parsed = JSON.parse(ta.value)
        ok = true
        init.onChange(parsed)
      } catch {
        ok = false
      }
      render([])
    })
    return {
      destroy: () => wrap.remove(),
      validate: () => (ok ? [] : [{ path: 'payload', code: 'payload_invalid', message: L.badJson }]),
      // Server-style paths ("payload.heroes.0.stockId"); a real plugin should also accept bare paths.
      setErrors: (errors) => render(errors),
    }
  },
}

export default plugin
