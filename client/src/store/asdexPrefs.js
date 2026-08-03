// Last-set ASDE-X display preferences — persisted to localStorage. Same
// plain-localStorage pattern as store/abmPrefs.js / store/catccPrefs.js /
// store/starsPrefs.js (not zustand's persist middleware): only the DCB
// spinner values below survive a reload — pan/zoom/range and other window
// state intentionally stay in store/display.js's session-only windows state.

const KEY = 'tracs-asdex-prefs'

const DEFAULTS = {
  ptlLength:    0.0,
  ldrLength:    2,
  ldrAngleDeg: -45,
  historyLength: 5,
  historyRate:   4.5,
}

export function loadAsdexPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY))
    return saved ? { ...DEFAULTS, ...saved } : { ...DEFAULTS }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveAsdexPrefs(patch) {
  try {
    const current = JSON.parse(localStorage.getItem(KEY)) ?? {}
    localStorage.setItem(KEY, JSON.stringify({ ...current, ...patch }))
  } catch {}
}
