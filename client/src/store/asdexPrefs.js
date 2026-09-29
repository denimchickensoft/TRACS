// Last-set ASDE-X display preferences — persisted to localStorage. Same
// plain-localStorage pattern as store/abmPrefs.js / store/catccPrefs.js /
// store/starsPrefs.js (not zustand's persist middleware): only the DCB
// spinner values, DB EDIT toggles and .COLORS/.CENTERLINE/.COORDS below survive a reload — pan/zoom/range and other window
// state intentionally stay in store/display.js's session-only windows state.

import { makePrefsStore } from '../utils/prefsStore.js'

const KEY = 'tracs.asdex.prefs'

const DEFAULTS = {
  ptlLength:    0.0,
  ldrLength:    2,
  ldrAngleDeg: -45,
  historyLength: 5,
  historyRate:   4.5,
  // DB EDIT submenu (CRC ASDE-X Data Block Edit)
  dbFull:        true,
  dbAltitude:    true,
  dbType:        true,
  dbFix:         true,
  dbVelocity:    true,
  dbScratch:     true,
  // Dot commands
  colorProfile:      null,   // .COLORS profile name (by name, not index, so a reordered asdex-colors.json still resolves)
  centerlineVisible: false,  // .CENTERLINE
  coordsVisible:     false,  // .COORDS
}

const { load: loadAsdexPrefs, save: saveAsdexPrefs } = makePrefsStore(KEY, DEFAULTS)
export { loadAsdexPrefs, saveAsdexPrefs }
