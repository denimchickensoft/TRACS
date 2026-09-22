'use strict'

// One-off repair tool: regenerates airports_polygons.json for theatres whose
// rn5 data tripped the near-origin sentinel bug fixed in
// server/scripts/lib/airportPolygonsCore.js (extractRn5/stripLeadingSentinel),
// using the already-persisted raw pre-projection dump in
// resources/airports/raw/ instead of needing DCS reinstalled.
//
// Only reprocesses theatres named on the command line. For a theatre the bug
// never touched, this would reproduce the exact same output anyway, so
// there's no reason to churn its cache file.
//
// Usage:
//   node server/scripts/reprocessAirportsFromRaw.js Germany SouthAtlantic

const fs   = require('fs')
const path = require('path')
const core = require('./lib/airportPolygonsCore')

const ROOT        = path.join(__dirname, '../..')
const CACHE_DIR   = path.join(__dirname, '../navdata/cache')
const RAW_DIR     = path.join(ROOT, 'resources/airports/raw')
const RUNWAYS_DIR = path.join(ROOT, 'client/public/runways')
const TM_PARAMS   = JSON.parse(fs.readFileSync(path.join(__dirname, '../navdata/config/projection_params.json'), 'utf8'))
const NAME_MAP    = JSON.parse(fs.readFileSync(path.join(__dirname, '../navdata/config/airport_name_map.json'), 'utf8'))
const THEATRES    = JSON.parse(fs.readFileSync(path.join(__dirname, '../navdata/config/theatres.json'), 'utf8'))

function reprocessTheatre(theatre, tmInverse) {
  const conf = THEATRES[theatre]
  const tm   = TM_PARAMS[theatre]
  if (!conf || !tm) { console.log(`  ${theatre}: skipped - no theatres.json/projection_params.json entry`); return }

  const rawPath = path.join(RAW_DIR, `${conf.folder}.json`)
  if (!fs.existsSync(rawPath)) { console.log(`  ${theatre}: skipped - no raw dump at ${path.relative(ROOT, rawPath)}`); return }
  const rawDump = JSON.parse(fs.readFileSync(rawPath, 'utf8'))

  const rwFile = conf.runwayKey || theatre
  const rwPath = path.join(RUNWAYS_DIR, `${rwFile}.json`)
  if (!fs.existsSync(rwPath)) { console.log(`  ${theatre}: skipped - no runway JSON at ${path.relative(ROOT, rwPath)}`); return }
  const rwJson = JSON.parse(fs.readFileSync(rwPath, 'utf8'))

  const nameMap = NAME_MAP[theatre] || {}

  const [minLon, minLat, maxLon, maxLat] = conf.bbox
  const PAD = 2
  const tmInv = core.makeTmInv(tmInverse, tm, minLat - PAD, maxLat + PAD, minLon - PAD, maxLon + PAD)

  const rwByAirbase = {}
  for (const ab of rwJson.airbases) {
    const rwys = (Array.isArray(ab.runways) ? ab.runways : []).filter(r => (r.width_ft || 0) > 0 && r.end1 && r.end2)
    if (rwys.length) rwByAirbase[ab.airbase] = rwys
  }

  const taxiFeatures = []
  const rwyFeatures  = []
  const matchedAirbases = new Set()
  const unmatchedStems = []
  let strippedSentinels = 0
  let droppedSegments = 0

  const stems = Object.keys(rawDump.taxiways).sort()
  for (const stem of stems) {
    const rawSegs = rawDump.taxiways[stem]
    const segs = []
    for (const rawSeg of rawSegs) {
      const before = rawSeg.length
      const projected = core.projectSegment(rawSeg, tmInv)
      if (!projected) { droppedSegments++; continue }
      if (projected.nodes.length < before) strippedSentinels++
      segs.push(projected.nodes)
    }

    for (const coords of segs) {
      const ring = core.bufferPolyline(coords, core.TAXIWAY_WIDTH_M / 2)
      if (!ring) continue
      taxiFeatures.push({
        type: 'Feature',
        properties: { airport: stem, type: 'taxiway', width_m: core.TAXIWAY_WIDTH_M },
        geometry: { type: 'Polygon', coordinates: [ring] },
      })
    }

    const airbaseName = nameMap[stem]
    const runways     = airbaseName ? rwByAirbase[airbaseName] : null
    if (runways) {
      matchedAirbases.add(airbaseName)
      for (const rwy of runways) {
        const widthM = rwy.width_ft * 0.3048
        const ring   = core.bufferPolyline(
          [[rwy.end1.lon, rwy.end1.lat], [rwy.end2.lon, rwy.end2.lat]],
          widthM / 2
        )
        if (!ring) continue
        rwyFeatures.push({
          type: 'Feature',
          properties: { airport: stem, type: 'runway', width_m: +widthM.toFixed(1) },
          geometry: { type: 'Polygon', coordinates: [ring] },
        })
      }
    } else {
      unmatchedStems.push(stem)
    }
  }

  const outDir  = path.join(CACHE_DIR, conf.folder)
  const outPath = path.join(outDir, 'airports_polygons.json')
  const beforeCount = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')).features.length : null
  const afterCount  = taxiFeatures.length + rwyFeatures.length
  const json = JSON.stringify({ type: 'FeatureCollection', features: [...taxiFeatures, ...rwyFeatures] })
  fs.writeFileSync(outPath, json)

  const kb = (json.length / 1024).toFixed(0)
  console.log(
    `${theatre.padEnd(16)}  ${String(stems.length).padStart(3)} airports  ` +
    `${String(taxiFeatures.length).padStart(5)} taxiways  ` +
    `${String(rwyFeatures.length).padStart(3)} runways  ` +
    `${kb.padStart(6)} KB  (was ${beforeCount} features, now ${afterCount})`
  )
  console.log(
    `                stripped ${strippedSentinels} leading sentinel node(s), ` +
    `dropped ${droppedSegments} still-invalid segment(s), ` +
    `${unmatchedStems.length} stems unmatched to a runway`
  )
}

async function main() {
  const theatreArgs = process.argv.slice(2)
  if (!theatreArgs.length) {
    console.error('Usage: node server/scripts/reprocessAirportsFromRaw.js <Theatre> [<Theatre> ...]')
    process.exit(1)
  }
  for (const t of theatreArgs) {
    if (!THEATRES[t]) {
      console.error(`Unknown theatre "${t}". Options: ${Object.keys(THEATRES).join(', ')}`)
      process.exit(1)
    }
  }

  console.log('\nReprocessing airport polygons from cached raw taxiway data\n')

  const { tmInverse } = await import('tracs-geo-math')
  for (const t of theatreArgs) reprocessTheatre(t, tmInverse)

  console.log('\nDone.\n')
}

main().catch((err) => { console.error(err); process.exit(1) })
