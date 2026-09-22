'use strict'

const path = require('path')

// Effective, overridable location for the four "seed a bundled default once,
// then the operator's own edited copy wins forever" files (rateConfig.json,
// tacviewDetectionConfig.json, airspace_colors.json, asdex_colors.json).
// Set by electron/main.js to a userData subfolder so hand-edited operator
// config survives app updates — the NSIS updater's uninstallOldVersion step
// RMDir /r's the entire install directory before laying down a new version,
// so nothing under __dirname ever survives an update. Same pattern as
// TRACS_STATE_DIR (stateFiles.js) / TRACS_NAVDATA_CACHE_DIR (navdata/
// parser.js). null when unset (dev/plain `npm start`, no Electron) — callers
// fall back to their own historical __dirname-relative default path.
const CONFIG_DIR = process.env.TRACS_CONFIG_DIR
  ? path.resolve(process.env.TRACS_CONFIG_DIR)
  : null

module.exports = { CONFIG_DIR }
