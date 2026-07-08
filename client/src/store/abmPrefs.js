// Last-set ABM display preferences — persisted to localStorage so a
// controller's chosen scope config (datablocks, leader style, navdata
// layers, airspace categories, coord readout, acq/eng rings) survives a
// reload/relaunch. Deliberately separate from store/display.js's windows
// state, which also carries per-session pan/zoom/mission-specific values
// (centerLat/Lng, ringAnchor*, leaderDirs, declarations, etc.) that must
// NOT persist — see 2026-07-08 discussion. Same plain-localStorage pattern
// as store/maps.js's saveVisible/loadSaved, not zustand's persist
// middleware, since only a subset of two different stores' fields need
// saving here.

const KEY = 'tracs-abm-prefs'

const DEFAULTS = {
  dbVisible:      true,
  dbSuppress:     true,
  ldrLength:      2,
  ldrAngleDeg:    -45,
  ptlMinutes:     1,
  fadedSeconds:   30,
  threatRadius:   45,
  ringsVisible:   false,
  ringSpacingNm:  20,
  mgrsVisible:    false,
  fixesVisible:   false,
  navaidsVisible: false,
  runwaysVisible: false,
  polygonsVisible: false,
  asVisible:      {},    // { [displayCategory]: bool }
  coordsVisible:  false,
  coordFormat:    'dms', // 'dms' | 'ddm'
  elevUnit:       'feet', // 'feet' | 'meters'
  acqHidden:      [],    // DECLARATION[]
  engHidden:      [],    // DECLARATION[]
}

export function loadAbmPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY))
    return saved ? { ...DEFAULTS, ...saved } : { ...DEFAULTS }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveAbmPrefs(patch) {
  try {
    const current = JSON.parse(localStorage.getItem(KEY)) ?? {}
    localStorage.setItem(KEY, JSON.stringify({ ...current, ...patch }))
  } catch {}
}
