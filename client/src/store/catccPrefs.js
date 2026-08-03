// Last-set CATCC display preferences — persisted to localStorage. Same
// plain-localStorage pattern as store/abmPrefs.js (not zustand's persist
// middleware): only a small subset of window state needs to survive a
// reload, the rest (pan/zoom, marshal bearing, mission-specific values)
// intentionally stays in store/display.js's session-only windows state.

const KEY = 'tracs-catcc-prefs'

const DEFAULTS = {
  dbca: true, // datablock collision avoidance — on by default for CATCC, unlike ATC/ABM
  asVisible:     {},    // { [displayCategory]: bool } — .asp/.sua/.classc/etc, same categories as ABM
  aspColorIdx:   null,  // index into airspace_colors.json palette array; null = default to the "CATCC" named palette
  labelsVisible: false, // airspace/fix name labels — .labels toggles
  fixesVisible:  false, // .fixes toggles
  geoVisible:    false, // .geo toggles (boundaries/coastlines)
  fillVisible:   false, // airspace polygon fill — .fill toggles
  fillPct:       30,    // 1-100 — .fill <n> sets this and turns fillVisible on
}

export function loadCatccPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY))
    return saved ? { ...DEFAULTS, ...saved } : { ...DEFAULTS }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveCatccPrefs(patch) {
  try {
    const current = JSON.parse(localStorage.getItem(KEY)) ?? {}
    localStorage.setItem(KEY, JSON.stringify({ ...current, ...patch }))
  } catch {}
}
