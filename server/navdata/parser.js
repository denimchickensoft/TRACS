'use strict'

const fs         = require('fs')
const path       = require('path')
const crypto     = require('crypto')
const stateFiles = require('../src/stateFiles')
const { runExtract } = require('./tools/extract-navdata')
const { CONFIG_DIR: USER_CONFIG_DIR } = require('../src/configDir')

const CONFIG_DIR = path.join(__dirname, 'config')

// Effective location for the two operator-tunable color-palette files only
// (airspace_colors.json, asdex_colors.json). Falls back to this module's own
// bundled CONFIG_DIR (unchanged) when no TRACS_CONFIG_DIR override is active.
// theatres.json/airport_name_map.json/projection_params.json are NOT
// operator-tunable and always resolve via CONFIG_DIR itself, never this —
// a shipped update to those must always take effect, never be shadowed by a
// stale seeded copy.
const COLOR_CONFIG_DIR = USER_CONFIG_DIR ?? CONFIG_DIR

// Two cache locations:
//  - BUNDLED_CACHE_DIR: wherever this code ships from (read-only in a
//    packaged app - the install directory). Holds the bundled, non-LNM
//    theatre data (geo/relief/basemap/terrain/roads/water/mva/
//    airports_polygons), read directly from here, never copied.
//  - CACHE_DIR: the writable location for LNM-derived extraction output,
//    overridable via TRACS_NAVDATA_CACHE_DIR (same pattern as TRACS_STATE_DIR
//    in server/src/stateFiles.js). electron/main.js points it at a userData
//    subfolder, since the install directory isn't reliably writable and is
//    replaced on every update.
// In dev/plain `npm start` (no override) the two are the same folder.
const BUNDLED_CACHE_DIR = path.join(__dirname, 'cache')
const CACHE_DIR = process.env.TRACS_NAVDATA_CACHE_DIR
  ? path.resolve(process.env.TRACS_NAVDATA_CACHE_DIR)
  : BUNDLED_CACHE_DIR

// Files required in every theatre cache folder for the cache to be valid
const REQUIRED_THEATRE_FILES = [
  'fixes.json', 'navaids.json', 'airspace.json', 'ctrs.json',
  'holdings.json', 'airways.json', 'msa.json', 'mora.json',
]

// Runs once at server startup (see navdata/index.js's init()). Detects
// whether the configured LNM database is new/changed/missing-cache since the
// last extraction (mtime + size - cheap stat-only check, no content hash) and
// re-extracts automatically so a Navigraph AIRAC-cycle update on disk is
// picked up on the next launch with no manual "Save" action required.
// Deliberately synchronous/blocking (matches handleSetLnmConfig's existing
// manual-save path) — safe here because this only ever runs before any
// controller has logged into a scope, never mid-session.
async function buildCache() {
  const LNM_DB_PATH = stateFiles.read('navdata').lnmDbPath
  if (!LNM_DB_PATH) {
    console.log('[navdata] no LNM database configured - set it in Settings')
    return
  }
  if (!fs.existsSync(LNM_DB_PATH)) {
    console.log('[navdata] LNM database not found - set it in Settings')
    return
  }

  const theatresRaw = fs.readFileSync(path.join(CONFIG_DIR, 'theatres.json'), 'utf8')
  const theatres    = JSON.parse(theatresRaw)
  const bboxHash    = crypto.createHash('sha256').update(theatresRaw).digest('hex').slice(0, 16)
  const lnmStat     = fs.statSync(LNM_DB_PATH)
  const lnmMtime    = lnmStat.mtime.toISOString()
  const lnmSize     = lnmStat.size

  const manifestPath = path.join(CACHE_DIR, 'manifest.json')
  let reason
  if (fs.existsSync(manifestPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      if (m.lnmMtime === lnmMtime && m.lnmSize === lnmSize && m.bboxHash === bboxHash) {
        const allPresent = Object.values(theatres).every((tConf) =>
          REQUIRED_THEATRE_FILES.every((f) => fs.existsSync(path.join(CACHE_DIR, tConf.folder, f)))
        )
        if (allPresent) {
          console.log(`[navdata] cache hit - built ${m.builtAt}`)
          return
        }
        reason = 'cache incomplete'
      } else {
        reason = 'LNM database changed'
      }
    } catch {
      reason = 'manifest corrupt'
    }
  } else {
    reason = 'no cache'
  }

  console.log(`[navdata] ${reason} - extracting...`)
  await runExtract(LNM_DB_PATH)
  console.log('[navdata] extraction complete')
}

module.exports = { buildCache, CACHE_DIR, BUNDLED_CACHE_DIR, CONFIG_DIR, COLOR_CONFIG_DIR }
