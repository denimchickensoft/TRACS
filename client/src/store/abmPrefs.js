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
// This file only owns the subset of ABM's persisted display settings that
// mirror store/display.js's per-window fields (rings/leader/history/etc,
// dual-written at the point of each command) plus aspColorIdx (loaded once
// into store/abmAirspace.js at mount, saved at the .aspcolors command site).
// The other ~24 local-UI toggles (navdata layers, airspace visibility, coord
// readout, acq/eng rings, etc.) moved to store/abmUiPrefs.js on 2026-08-22 —
// a genuine reactive store, not a load/save pair backing local useState —
// see that file's header and resources/specs/refactor-spec.md §10. Both
// files share this localStorage key (KEY below); see abmUiPrefs.js's header
// for why that's safe.

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
  aspColorIdx:    0,     // index into airspace_colors.json palette array
  historyVisible: true,
  historyLength:  4,     // trail points shown, capped by AbmScope's MAX_HISTORY
  historyRate:    4.5,   // seconds between trail captures
  dbca:           false, // datablock collision avoidance — off by default (on for CATCC only)
}

const { load: loadAbmPrefs, save: saveAbmPrefs } = makePrefsStore(KEY, DEFAULTS)
export { loadAbmPrefs, saveAbmPrefs }
