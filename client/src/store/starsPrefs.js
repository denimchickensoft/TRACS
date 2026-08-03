// Last-set STARS display preferences — persisted to localStorage. Same
// plain-localStorage pattern as store/abmPrefs.js / store/catccPrefs.js (not
// zustand's persist middleware): STARS' bulk of display settings come from
// server-side ODS profiles (store/presets.js) or session-only window state
// (store/display.js) — this only holds the handful of prefs that should
// survive a reload independent of the active profile.

const KEY = 'tracs-stars-prefs'

const DEFAULTS = {
  dbca: false, // datablock collision avoidance — off by default (on for CATCC only)
  fillVisible: false, // airspace polygon fill — .fill toggles
  fillPct: 30, // 1-100 — .fill <n> sets this and turns fillVisible on
}

export function loadStarsPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY))
    return saved ? { ...DEFAULTS, ...saved } : { ...DEFAULTS }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveStarsPrefs(patch) {
  try {
    const current = JSON.parse(localStorage.getItem(KEY)) ?? {}
    localStorage.setItem(KEY, JSON.stringify({ ...current, ...patch }))
  } catch {}
}
