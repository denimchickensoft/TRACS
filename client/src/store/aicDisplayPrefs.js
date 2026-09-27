// Last-set AIC window display settings — persisted to localStorage with the
// same plain-localStorage pattern as store/starsPrefs.js. Separate from
// store/aicPrefs.js, which holds AIC's reactive command toggles. AicScope
// seeds the AIC window from this on mount and saves it (debounced) whenever
// the window, geo or relief settings change. geoVisible/reliefVisible have
// no default here so an unsaved profile leaves those stores' own defaults.

import { makePrefsStore } from '../utils/prefsStore.js'

const KEY = 'tracs.aic.display'

const DEFAULTS = {
  rangeNm:          120,
  ringSpacingNm:    20,
  ptlSeconds:       60,
  symSize:          3,
  centerLat:        0,
  centerLng:        0,
  centerOverridden: false,
  fadedSeconds:     30,
  threatRadius:     35,
}

const { load: loadAicDisplayPrefs, save: saveAicDisplayPrefs } = makePrefsStore(KEY, DEFAULTS)
export { loadAicDisplayPrefs, saveAicDisplayPrefs }
