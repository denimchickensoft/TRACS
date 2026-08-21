// Last-set ASDE-X display preferences — persisted to localStorage. Same
// plain-localStorage pattern as store/abmPrefs.js / store/catccPrefs.js /
// store/starsPrefs.js (not zustand's persist middleware): only the DCB
// spinner values below survive a reload — pan/zoom/range and other window
// state intentionally stay in store/display.js's session-only windows state.

import { makePrefsStore } from '../utils/prefsStore.js'

const KEY = 'tracs-asdex-prefs'

const DEFAULTS = {
  ptlLength:    0.0,
  ldrLength:    2,
  ldrAngleDeg: -45,
  historyLength: 5,
  historyRate:   4.5,
}

const { load: loadAsdexPrefs, save: saveAsdexPrefs } = makePrefsStore(KEY, DEFAULTS)
export { loadAsdexPrefs, saveAsdexPrefs }
