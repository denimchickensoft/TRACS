'use strict'

// Builds per-theatre airport surface polygon data for the ASDE-X module.
// For each theatre, reads DCS rn5 binary files (taxiway centerlines) and
// DCS runway JSON (authoritative runway endpoints), applies a two-layer
// superimposition approach, and writes:
//   server/navdata/cache/<folder>/airports_polygons.json
//   server/navdata/cache/<folder>/airports_raw.json (taxiway nodes in DCS's
//     native theatre-grid meters, pre-projection — lets a future rebuild
//     regenerate airports_polygons.json without needing DCS installed again)
//
// Usage:
//   node server/scripts/buildAirportPolygons.js [theatre]
//   node server/scripts/buildAirportPolygons.js [--dcs-path <path>] [theatre]
//
// DCS terrain path defaults to the Steam installation. Override with --dcs-path.
//
// See also: server/scripts/terrainDataExe — a standalone .exe build of this
// same logic (via server/scripts/lib/airportPolygonsCore.js) for distribution
// to machines without this repo checked out.

const fs   = require('fs')
const path = require('path')
const core = require('./lib/airportPolygonsCore')

const ROOT         = path.join(__dirname, '../..')
const CACHE_DIR    = path.join(__dirname, '../navdata/cache')
const TM_PARAMS    = JSON.parse(fs.readFileSync(path.join(__dirname, '../navdata/config/projection_params.json'), 'utf8'))
const NAME_MAP     = JSON.parse(fs.readFileSync(path.join(__dirname, '../navdata/config/airport_name_map.json'), 'utf8'))
const THEATRES     = JSON.parse(fs.readFileSync(path.join(__dirname, '../navdata/config/theatres.json'), 'utf8'))

const DEFAULT_DCS_PATH = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\DCSWorld\\Mods\\terrains'

function buildAndWriteTheatre(theatre, dcsPath, tmInverse) {
  const tm      = TM_PARAMS[theatre]
  const nameMap = NAME_MAP[theatre] || {}
  const conf    = THEATRES[theatre]

  if (!conf) {
    console.log(`  ${theatre}: skipped - no theatres.json entry`)
    return
  }

  const rwFile = conf.runwayKey || theatre
  const rwPath = path.join(ROOT, 'client/public/runways', `${rwFile}.json`)
  const rwJson = fs.existsSync(rwPath) ? JSON.parse(fs.readFileSync(rwPath, 'utf8')) : null

  const result = core.buildTheatre({ theatre, terrainsDir: dcsPath, tm, nameMap, conf, rwJson, tmInverse })

  if (result.status === 'skip') {
    console.log(`  ${theatre}: skipped - ${result.reason}`)
    return
  }

  const outDir = path.join(CACHE_DIR, conf.folder)
  fs.mkdirSync(outDir, { recursive: true })
  const json = JSON.stringify({ type: 'FeatureCollection', features: result.features })
  fs.writeFileSync(path.join(outDir, 'airports_polygons.json'), json)
  fs.writeFileSync(path.join(outDir, 'airports_raw.json'), JSON.stringify({ theatre, ...result.raw }))

  const kb = (json.length / 1024).toFixed(0)
  console.log(
    `${theatre.padEnd(16)}  ${String(result.airportCount).padStart(3)} airports  ` +
    `${String(result.taxiCount).padStart(5)} taxiways  ` +
    `${String(result.rwyCount).padStart(3)} runways  ` +
    `${kb.padStart(6)} KB`
  )

  if (result.unmatchedStems.length || result.unclaimedAirbases.length) {
    fs.writeFileSync(
      path.join(outDir, 'unmatched_airports.json'),
      JSON.stringify({
        theatre,
        unmatchedStems: result.unmatchedStems,
        unclaimedAirbases: result.unclaimedAirbases,
        suggestedPairs: result.suggestedPairs,
      }, null, 1)
    )
    console.log(
      `                ${result.unmatchedStems.length} rn5 stems have no airport_name_map entry, ` +
      `${result.unclaimedAirbases.length} runway-JSON airbases unclaimed, ` +
      `${result.suggestedPairs.length} suggested by location -> unmatched_airports.json`
    )
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  let dcsPath = DEFAULT_DCS_PATH
  const args  = process.argv.slice(2)
  const dpIdx = args.indexOf('--dcs-path')
  if (dpIdx !== -1) {
    dcsPath = args[dpIdx + 1]
    args.splice(dpIdx, 2)
  }

  const only = args[0]
  if (only && !TM_PARAMS[only]) {
    console.error(`Unknown theatre "${only}". Options: ${Object.keys(TM_PARAMS).join(', ')}`)
    process.exit(1)
  }

  console.log('\nBuilding airport polygon data\n')
  console.log(`DCS path: ${dcsPath}\n`)

  const { tmInverse } = await import('tracs-geo-math')

  const theatres = only ? [only] : Object.keys(TM_PARAMS)
  for (const t of theatres) buildAndWriteTheatre(t, dcsPath, tmInverse)

  console.log('\nDone.\n')
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1) })
