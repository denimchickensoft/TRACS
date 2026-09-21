'use strict'

// Rebuilds airports_polygons.json from a previously-cached airports_raw.json,
// without reading rn5 files from a DCS install. Use this after adding new
// airport_name_map.json entries (e.g. from a prior run's suggestedPairs) to
// bake in runway polygons that the original extraction couldn't match yet.
//
// Usage: node server/scripts/rebuildAirportPolygonsFromRaw.js <theatre>

const fs   = require('fs')
const path = require('path')
const core = require('./lib/airportPolygonsCore')

const ROOT       = path.join(__dirname, '../..')
const CACHE_DIR  = path.join(__dirname, '../navdata/cache')
const NAME_MAP   = JSON.parse(fs.readFileSync(path.join(__dirname, '../navdata/config/airport_name_map.json'), 'utf8'))
const THEATRES   = JSON.parse(fs.readFileSync(path.join(__dirname, '../navdata/config/theatres.json'), 'utf8'))

async function main() {
  const theatre = process.argv[2]
  if (!theatre || !THEATRES[theatre]) {
    console.error(`Usage: node server/scripts/rebuildAirportPolygonsFromRaw.js <theatre>`)
    console.error(`Known theatres: ${Object.keys(THEATRES).join(', ')}`)
    process.exit(1)
  }

  const conf = THEATRES[theatre]
  const rawPath = path.join(CACHE_DIR, conf.folder, 'airports_raw.json')
  if (!fs.existsSync(rawPath)) {
    console.error(`${theatre}: no cached airports_raw.json at ${rawPath}`)
    process.exit(1)
  }
  const rawExport = JSON.parse(fs.readFileSync(rawPath, 'utf8'))

  const rwFile = conf.runwayKey || theatre
  const rwPath = path.join(ROOT, 'client/public/runways', `${rwFile}.json`)
  if (!fs.existsSync(rwPath)) {
    console.error(`${theatre}: no runway JSON at ${rwPath}`)
    process.exit(1)
  }
  const rwJson = JSON.parse(fs.readFileSync(rwPath, 'utf8'))

  const nameMap = NAME_MAP[theatre] || {}

  const { tmInverse } = await import('tracs-geo-math')

  const result = core.buildTheatreFromRaw({
    tm: rawExport.tm,
    nameMap,
    conf,
    rwJson,
    rawTaxiways: rawExport.taxiways,
    tmInverse,
  })

  if (result.status === 'skip') {
    console.error(`${theatre}: skipped — ${result.reason}`)
    process.exit(1)
  }

  const outDir = path.join(CACHE_DIR, conf.folder)
  const json = JSON.stringify({ type: 'FeatureCollection', features: result.features })
  fs.writeFileSync(path.join(outDir, 'airports_polygons.json'), json)

  const kb = (json.length / 1024).toFixed(0)
  console.log(
    `${theatre.padEnd(16)}  ${String(result.airportCount).padStart(3)} airports  ` +
    `${String(result.taxiCount).padStart(5)} taxiways  ` +
    `${String(result.rwyCount).padStart(3)} runways  ` +
    `${kb.padStart(6)} KB`
  )

  const unmatchedPath = path.join(outDir, 'unmatched_airports.json')
  if (result.unmatchedStems.length || result.unclaimedAirbases.length) {
    fs.writeFileSync(
      unmatchedPath,
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
  } else if (fs.existsSync(unmatchedPath)) {
    fs.unlinkSync(unmatchedPath)
    console.log(`                all stems matched — removed stale unmatched_airports.json`)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
