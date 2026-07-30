'use strict'

// Builds per-theatre airport surface polygon data for the ASDE-X module.
// For each theatre, reads DCS rn5 binary files (taxiway centerlines) and
// DCS runway JSON (authoritative runway endpoints), applies a two-layer
// superimposition approach, and writes:
//   server/navdata/cache/<folder>/airports_polygons.json
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

function buildAndWriteTheatre(theatre, dcsPath) {
  const tm      = TM_PARAMS[theatre]
  const nameMap = NAME_MAP[theatre] || {}
  const conf    = THEATRES[theatre]

  const rwFile = core.RUNWAY_FILE[theatre] ?? theatre
  const rwPath = path.join(ROOT, 'client/public/runways', `${rwFile}.json`)
  const rwJson = fs.existsSync(rwPath) ? JSON.parse(fs.readFileSync(rwPath, 'utf8')) : null

  const result = core.buildTheatre({ theatre, terrainsDir: dcsPath, tm, nameMap, conf, rwJson })

  if (result.status === 'skip') {
    console.log(`  ${theatre}: skipped — ${result.reason}`)
    return
  }

  const outDir = path.join(CACHE_DIR, conf.folder)
  fs.mkdirSync(outDir, { recursive: true })
  const json = JSON.stringify({ type: 'FeatureCollection', features: result.features })
  fs.writeFileSync(path.join(outDir, 'airports_polygons.json'), json)

  const kb = (json.length / 1024).toFixed(0)
  console.log(
    `${theatre.padEnd(16)}  ${String(result.airportCount).padStart(3)} airports  ` +
    `${String(result.taxiCount).padStart(5)} taxiways  ` +
    `${String(result.rwyCount).padStart(3)} runways  ` +
    `${kb.padStart(6)} KB`
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
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

  const theatres = only ? [only] : Object.keys(TM_PARAMS)
  for (const t of theatres) buildAndWriteTheatre(t, dcsPath)

  console.log('\nDone.\n')
}

if (require.main === module) main()
