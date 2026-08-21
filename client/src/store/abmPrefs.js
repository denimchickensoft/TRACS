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
  autoThreat:     false,
  ringsVisible:   false,
  ringSpacingNm:  20,
  mgrsVisible:    false,
  townsVisible:   false,
  terrainVisible: false, // .terrain — relief wash, formerly called "basemap" until 2026-08-11
  waterVisible:   false,
  roadsVisible:   false,
  basemapVisible: false, // .base — land/sea silhouette, formerly called "landfill" until 2026-08-11
  fixesVisible:   false,
  navaidsVisible: false,
  runwaysVisible: false,
  polygonsVisible: false,
  asVisible:      {},    // { [displayCategory]: bool }
  aspColorIdx:    0,     // index into airspace_colors.json palette array
  labelsVisible:  false, // airspace name labels — .labels toggles
  fillVisible:    false, // airspace polygon fill — .fill toggles
  fillPct:        30,    // 1-100 — .fill <n> sets this and turns fillVisible on
  coordsVisible:  false,
  coordFormat:    'dms', // 'dms' | 'ddm'
  elevUnit:       'feet', // 'feet' | 'meters'
  becVisible:     false, // bullseye-on-cursor readout — .bec toggles
  acqHidden:      [],    // DECLARATION[]
  engHidden:      [],    // DECLARATION[]
  historyVisible: true,
  historyLength:  4,     // trail points shown, capped by AbmScope's MAX_HISTORY
  historyRate:    4.5,   // seconds between trail captures
  dbca:           false, // datablock collision avoidance — off by default (on for CATCC only)
  timeVisible:    true,  // mission clock, top-center — .time toggles
  unitReadoutVisible: true, // cursor-proximity ground/air unit readout — .unitro toggles
  pinnedFixes:    {},    // { [theatre]: string[] } — .fix <name...> toggles, shown regardless of .fixes
}

const { load: loadAbmPrefs, save: saveAbmPrefs } = makePrefsStore(KEY, DEFAULTS)
export { loadAbmPrefs, saveAbmPrefs }
