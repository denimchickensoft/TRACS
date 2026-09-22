'use strict'

const fs         = require('fs')
const path       = require('path')
const crypto     = require('crypto')
const stateFiles = require('../src/stateFiles')
const { runExtract } = require('./tools/extract-navdata')
const { copyIfStaleOrMissing } = require('../src/utils/seedFile')
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

// BUNDLED_CACHE_DIR is always wherever this code ships from (read-only in a
// packaged app — the install directory). CACHE_DIR is the effective,
// writable location: overridable via TRACS_NAVDATA_CACHE_DIR (same pattern
// as TRACS_STATE_DIR in server/src/stateFiles.js), set by electron/main.js
// to a userData subfolder so LNM-derived extraction output never has to be
// written into the app's own install directory (not reliably writable, and
// wiped on every app update). In dev/plain `npm start` (no override), the
// two are identical and behavior is unchanged from before this existed.
const BUNDLED_CACHE_DIR = path.join(__dirname, 'cache')
const CACHE_DIR = process.env.TRACS_NAVDATA_CACHE_DIR
  ? path.resolve(process.env.TRACS_NAVDATA_CACHE_DIR)
  : BUNDLED_CACHE_DIR

// Files required in every theatre cache folder for the cache to be valid
const REQUIRED_THEATRE_FILES = [
  'fixes.json', 'navaids.json', 'airspace.json', 'ctrs.json',
  'holdings.json', 'airways.json', 'msa.json', 'mora.json',
]

// Copies bundled non-LNM theatre files (geo/relief/basemap/terrain/roads/
// water/mva/airports_polygons — never LNM-derived, since extraction only
// ever writes to CACHE_DIR, not BUNDLED_CACHE_DIR) into the effective
// CACHE_DIR whenever it's been relocated away from BUNDLED_CACHE_DIR. Only
// copies a file if it's missing or older than the bundled source — so a
// newer app version's refreshed bundled data gets picked up on next launch,
// while anything already extracted (LNM-derived) is never touched, since
// those files structurally never exist under BUNDLED_CACHE_DIR at all.
function seedBundledCache() {
  if (CACHE_DIR === BUNDLED_CACHE_DIR) return // no override active — nothing to seed
  if (!fs.existsSync(BUNDLED_CACHE_DIR)) return

  function copyRecursive(srcDir, destDir) {
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const srcPath  = path.join(srcDir, entry.name)
      const destPath = path.join(destDir, entry.name)
      if (entry.isDirectory()) {
        copyRecursive(srcPath, destPath)
        continue
      }
      copyIfStaleOrMissing(srcPath, destPath)
    }
  }
  copyRecursive(BUNDLED_CACHE_DIR, CACHE_DIR)
}

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

module.exports = { buildCache, seedBundledCache, CACHE_DIR, CONFIG_DIR, COLOR_CONFIG_DIR }
