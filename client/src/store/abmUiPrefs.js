import { create } from 'zustand'

// ABM's ~24 local-UI display toggles (navdata layers, airspace, coord
// readout, acq/eng rings, etc.) — a genuine reactive store, not the
// load/save-function-pair half-measure store/abmPrefs.js still is. Before
// 2026-08-22 these were each a plain component useState in AbmScope.jsx with
// a manual dual-write (setState + saveAbmPrefs) at every toggle site, which
// is exactly the closure-coupling problem blocking the STARS-pattern
// command-parser port (see resources/specs/refactor-spec.md §10) — same
// motivation and shape as store/aicPrefs.js's 3-field version.
//
// Deliberately shares abmPrefs.js's localStorage key ('tracs-abm-prefs')
// rather than using a new one, so upgrading users keep their saved toggle
// states — abmPrefs.js continues to own the displayStore-mirrored subset
// (rings/leader/history/etc — see its own header) plus aspColorIdx via
// loadAbmPrefs/saveAbmPrefs, untouched by this store. Both write paths do a
// synchronous read-current-blob → merge patch → write of the same JSON blob
// (see utils/prefsStore.js's `save`), which is safe to share since neither
// awaits between the read and the write — no torn writes.

const KEY = 'tracs-abm-prefs'

// store-field name -> on-disk JSON key, only where they differ. `clockVisible`
// predates this store and was always persisted under `timeVisible`.
const JSON_KEY = { clockVisible: 'timeVisible' }
const toJsonKey = (field) => JSON_KEY[field] ?? field

// Fields whose in-memory shape is a Set (component code calls .has()/.size
// on them) but which must serialize as a plain array on disk, same
// Set<->array boundary AIC's threatRings needed.
const SET_FIELDS = new Set(['acqHidden', 'engHidden'])

const DEFAULTS = {
  clockVisible: true,
  unitReadoutVisible: true,
  asVisible: {},
  labelsVisible: false,
  fillVisible: false,
  fillPct: 30,
  fixesVisible: false,
  navaidsVisible: false,
  pinnedFixes: {},
  runwaysVisible: false,
  polygonsVisible: false,
  mgrsVisible: false,
  townsVisible: false,
  basemapVisible: false,
  terrainVisible: false,
  waterVisible: false,
  roadsVisible: false,
  coordsVisible: false,
  coordFormat: 'dms',
  elevUnit: 'feet',
  becVisible: false,
  acqHidden: [],
  engHidden: [],
  autoThreat: false,
}

function loadPersisted() {
  let saved
  try { saved = JSON.parse(localStorage.getItem(KEY)) } catch { /* ignore, fall back to defaults */ }
  const merged = { ...DEFAULTS }
  for (const field of Object.keys(DEFAULTS)) {
    const raw = saved?.[toJsonKey(field)]
    if (raw !== undefined) merged[field] = raw
  }
  for (const field of SET_FIELDS) merged[field] = new Set(merged[field])
  return merged
}

function persist(patch) {
  try {
    const current = JSON.parse(localStorage.getItem(KEY)) ?? {}
    const diskPatch = {}
    for (const [field, value] of Object.entries(patch)) {
      diskPatch[toJsonKey(field)] = SET_FIELDS.has(field) ? [...value] : value
    }
    localStorage.setItem(KEY, JSON.stringify({ ...current, ...diskPatch }))
  } catch {
    // ignore (e.g. private browsing quota)
  }
}

// Matches useState's setter signature (accepts either a plain value or an
// updater function of the previous value) so every existing call site in
// AbmScope.jsx — including the one functional-update use, `.tma`/etc's
// per-category asVisible toggle — keeps working unchanged.
function setterFor(set, field) {
  return (updater) => set((state) => ({
    [field]: typeof updater === 'function' ? updater(state[field]) : updater,
  }))
}

export const useAbmUiPrefsStore = create((set) => ({
  ...loadPersisted(),
  setClockVisible: setterFor(set, 'clockVisible'),
  setUnitReadoutVisible: setterFor(set, 'unitReadoutVisible'),
  setAsVisible: setterFor(set, 'asVisible'),
  setLabelsVisible: setterFor(set, 'labelsVisible'),
  setFillVisible: setterFor(set, 'fillVisible'),
  setFillPct: setterFor(set, 'fillPct'),
  setFixesVisible: setterFor(set, 'fixesVisible'),
  setNavaidsVisible: setterFor(set, 'navaidsVisible'),
  setPinnedFixes: setterFor(set, 'pinnedFixes'),
  setRunwaysVisible: setterFor(set, 'runwaysVisible'),
  setPolygonsVisible: setterFor(set, 'polygonsVisible'),
  setMgrsVisible: setterFor(set, 'mgrsVisible'),
  setTownsVisible: setterFor(set, 'townsVisible'),
  setBasemapVisible: setterFor(set, 'basemapVisible'),
  setTerrainVisible: setterFor(set, 'terrainVisible'),
  setWaterVisible: setterFor(set, 'waterVisible'),
  setRoadsVisible: setterFor(set, 'roadsVisible'),
  setCoordsVisible: setterFor(set, 'coordsVisible'),
  setCoordFormat: setterFor(set, 'coordFormat'),
  setElevUnit: setterFor(set, 'elevUnit'),
  setBecVisible: setterFor(set, 'becVisible'),
  setAcqHidden: setterFor(set, 'acqHidden'),
  setEngHidden: setterFor(set, 'engHidden'),
  setAutoThreat: setterFor(set, 'autoThreat'),
}))

useAbmUiPrefsStore.subscribe((state, prevState) => {
  const patch = {}
  for (const field of Object.keys(DEFAULTS)) {
    if (state[field] !== prevState[field]) patch[field] = state[field]
  }
  if (Object.keys(patch).length) persist(patch)
})
