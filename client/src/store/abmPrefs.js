// Last-set ABM display preferences — persisted to localStorage so a
// controller's chosen scope config (rings, leader style, history trail,
// datablock behavior) survives a reload/relaunch. Deliberately separate
// from store/display.js's windows state, which also carries per-session
// pan/zoom/mission-specific values (centerLat/Lng, ringAnchor*, leaderDirs,
// declarations, etc.) that must NOT persist across sessions.
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
// are per-window seed defaults here (same role dbVisible/historyVisible
// play), not a shared reactive store: a single windowId-less value would
// make toggling e.g. `.coords` in one ABM window/`.focus` panel toggle it
// everywhere. See actions/index.js's GEO_TOGGLE comment for the live-value
// side.

import { makePrefsStore } from '../utils/prefsStore.js'

const KEY = 'tracs.abm.prefs'

const DEFAULTS = {
  dbVisible:      true,
  dbSuppress:     true,
  ldrLength:      2,
  ldrAngleDeg:    -45,
  csMap:          2,     // airspace/fix/drawing label size (0-5), see .labelsize
  dbSize:         2,     // aircraft datablock size (0-5), see .dbsize
  ptlMinutes:     1,
  fadedSeconds:   30,
  threatRadius:   35,
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
  missileAlertEnabled: true, // .malert — enemy missile-launch sound+blink alert, on by default
  alertVol:       10,    // .vol (0-10, 0=mute) — master volume for ABM alert tones (missile-launch today, shared by any future alert channel)

  // ── Per-window UI toggles — seeded per-window at open time (like
  // dbVisible/historyVisible above) rather than read live from a shared
  // store, so a `.focus` window's `.coords`/etc. can't leak into every other
  // open ABM window; this DEFAULTS entry only supplies the seed value.
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
  groundVisible:      true,
  autoThreat:         false,

  // ── Per-window navdata-layer visibility — geo/relief/
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
