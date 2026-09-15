// Last-set ABM display preferences — persisted to localStorage so a
// controller's chosen scope config (rings, leader style, history trail,
// datablock behavior) survives a reload/relaunch. Deliberately separate
// from store/display.js's windows state, which also carries per-session
// pan/zoom/mission-specific values (centerLat/Lng, ringAnchor*, leaderDirs,
// declarations, etc.) that must NOT persist — see 2026-07-08 discussion.
// Same plain-localStorage pattern as store/maps.js's saveVisible/loadSaved,
// not zustand's persist middleware, since only a subset of two different
// stores' fields need saving here.
//
// This file owns every one of ABM's persisted display settings — all seed
// values for store/display.js's per-window fields (rings/leader/history/db/
// navdata-layer-visibility/coord-readout/acq-eng/etc, dual-written at the
// point of each command) plus aspColorIdx (loaded once into
// store/abmAirspace.js at mount, saved at the .aspcolors command site).
// The ~24 navdata-layer/airspace-visibility/coord-readout/acq-eng toggles
// briefly lived in their own reactive store, store/abmUiPrefs.js
// (2026-08-22 - 2026-09-14), but that store was windowId-less — a single
// value shared by every open ABM window/`.focus` panel, so toggling e.g.
// `.coords` in one window silently toggled it everywhere. Merged back here
// 2026-09-14 as per-window seed defaults instead (same role dbVisible/
// historyVisible already played) — see actions/index.js's GEO_TOGGLE
// comment for the live-value side of this fix.

import { makePrefsStore } from '../utils/prefsStore.js'

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
  aspColorIdx:    0,     // index into airspace_colors.json palette array — also seeds useAbmAirspaceStore's global paletteIdx (Drawings.jsx CUSTOM color), see AbmScope's mount hydration
  historyVisible: true,
  historyLength:  4,     // trail points shown, capped by AbmScope's MAX_HISTORY
  historyRate:    4.5,   // seconds between trail captures
  dbca:           false, // datablock collision avoidance — off by default (on for CATCC only)
  focusDefaultRangeNm: 20, // default range for .focus <callsign> / double-click-to-focus popups when no range is given
  roeVisible:     true,  // ROE readout visibility default, seeded per window at open — see store/display.js
  compassVisible: true,  // compass rose visibility default, seeded per window at open (as windows[].briteCmp)
  bedbVisible:    false, // .bedb — bullseye-on-datablock 3rd line, off by default

  // ── Per-window UI toggles, merged in from store/abmUiPrefs.js (removed
  // 2026-09-14 — see resources/specs/refactor-spec.md §10 follow-up: every
  // ABM display toggle previously lived in a single windowId-less shared
  // store, so a `.focus` window's `.coords`/etc. leaked into every other
  // open ABM window. These are now seeded per-window at open time (like
  // dbVisible/historyVisible above) instead of read live from a shared
  // store; this DEFAULTS entry only supplies the seed value. Same on-disk
  // keys as the old store (shared 'tracs-abm-prefs' localStorage key), so
  // existing users' saved preferences carry over unchanged.
  // Named timeVisible (not clockVisible) to match the on-disk key
  // store/abmUiPrefs.js's old JSON_KEY mapping already used — makePrefsStore
  // has no key-remapping mechanism, so keeping the field name identical to
  // the disk key is what makes existing users' saved value carry over.
  timeVisible:        true,
  unitReadoutVisible: true,
  asVisible:          {},
  labelsVisible:      false,
  fillVisible:        false,
  fillPct:            30,
  fixesVisible:       false,
  navaidsVisible:     false,
  pinnedFixes:        {},
  runwaysVisible:     false,
  polygonsVisible:    false,
  mgrsVisible:        false,
  townsVisible:       false,
  basemapVisible:     false,
  terrainVisible:     false,
  waterVisible:       false,
  roadsVisible:       false,
  coordsVisible:      false,
  coordFormat:        'dms',
  elevUnit:           'feet',
  becVisible:         false,
  acqHidden:          [],
  engHidden:          [],
  autoThreat:         false,

  // ── Per-window navdata-layer visibility (2026-09-14) — geo/relief/
  // holdings/mora/airways stores are shared with STARS/CATCC/AIC (data
  // fetch + cache), but their single `visible` flag is not — those modules
  // have no window multiplicity, so they keep reading the shared store's
  // `visible` directly; ABM alone needed a per-window copy. geoVisible
  // defaults true to match ABM's prior forced-on-every-mount behavior (see
  // AbmScope's removed mount effect); the rest match their store's own
  // false default.
  geoVisible:      true,
  reliefVisible:   false,
  holdingsVisible: false,
  moraVisible:     false,
  airwaysVisible:  { V: false, J: false, B: false },
}

const { load: loadAbmPrefs, save: saveAbmPrefs } = makePrefsStore(KEY, DEFAULTS)
export { loadAbmPrefs, saveAbmPrefs }
