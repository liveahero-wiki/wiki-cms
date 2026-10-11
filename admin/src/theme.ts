import { useEffect, useState } from 'preact/hooks'

export type ThemePref = 'auto' | 'light' | 'dark'
const KEY = 'cms-admin-theme'
const listeners = new Set<() => void>()

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark') return v
  } catch {
    /* storage unavailable */
  }
  return 'auto'
}

function apply(pref: ThemePref) {
  const root = document.documentElement
  if (pref === 'auto') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', pref)
}

export function setThemePref(pref: ThemePref) {
  try {
    if (pref === 'auto') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, pref)
  } catch {
    /* storage unavailable */
  }
  apply(pref)
  listeners.forEach((l) => l())
}

export function initTheme() {
  apply(getThemePref())
}

const dark = () => window.matchMedia('(prefers-color-scheme: dark)')

export function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  return pref === 'auto' ? (dark().matches ? 'dark' : 'light') : pref
}

/** Current preference and the resolved light/dark value (re-renders on change). */
export function useTheme() {
  const [, bump] = useState(0)
  useEffect(() => {
    const update = () => bump((n) => n + 1)
    listeners.add(update)
    const mq = dark()
    mq.addEventListener('change', update)
    return () => {
      listeners.delete(update)
      mq.removeEventListener('change', update)
    }
  }, [])
  const pref = getThemePref()
  return { pref, resolved: resolveTheme(pref) }
}
