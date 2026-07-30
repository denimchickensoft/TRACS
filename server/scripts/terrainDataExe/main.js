'use strict'

// TRACS Terrain Data Builder — standalone CLI.
//
// Bundled by esbuild into a single CJS file and packaged as a Windows .exe
// via Node's Single Executable Application (SEA) support, so it can run on a
// machine that only has a DCS World install and no copy of this repo.
//
// Usage:
//   TracsTerrainDataBuilder.exe <dcs-installation-path> [theatre] [--out <dir>]
//
// <dcs-installation-path> is the DCS World install root (containing
// Mods\terrains) or the terrains folder itself — both are accepted.
//
// For each theatre, writes:
//   <out>/cache/<theatre-folder>/airports_polygons.json  (mirrors server/navdata/cache/)
//   <out>/towns/<Theatre>.json                            (mirrors client/public/towns/)
// <out> defaults to a "terrain_data" folder created next to the .exe.

const fs         = require('fs')
const path       = require('path')
const airportCore = require('../lib/airportPolygonsCore')
const townsCore    = require('../lib/townLabelsCore')

const TM_PARAMS = require('../../navdata/config/projection_params.json')
const NAME_MAP  = require('../../navdata/config/airport_name_map.json')
const THEATRES  = require('../../navdata/config/theatres.json')
const RUNWAYS   = require('./runwayData.generated.js')

let isSeaBinary = false
try { isSeaBinary = require('node:sea').isSea() } catch { /* Node < 21, or not built as SEA */ }

function resolveTerrainsDir(installPath) {
  const candidates = [
    path.join(installPath, 'Mods', 'terrains'),
    path.join(installPath, 'terrains'),
    installPath,
  ]
  for (const dir of candidates) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue
    const hasTheatre = Object.keys(THEATRES).some(t => fs.existsSync(path.join(dir, t)))
    if (hasTheatre) return dir
  }
  return null
}

function buildAirports(theatre, terrainsDir, outRoot) {
  const tm      = TM_PARAMS[theatre]
  const nameMap = NAME_MAP[theatre] || {}
  const conf    = THEATRES[theatre]
  const rwKey   = airportCore.RUNWAY_FILE[theatre] ?? theatre
  const rwJson  = RUNWAYS[rwKey] || null

  const result = airportCore.buildTheatre({ theatre, terrainsDir, tm, nameMap, conf, rwJson })

  if (result.status === 'skip') {
    console.log(`  airports  ${theatre}: skipped — ${result.reason}`)
    return
  }

  const outDir = path.join(outRoot, 'cache', conf.folder)
  fs.mkdirSync(outDir, { recursive: true })
  const json = JSON.stringify({ type: 'FeatureCollection', features: result.features })
  fs.writeFileSync(path.join(outDir, 'airports_polygons.json'), json)

  const kb = (json.length / 1024).toFixed(0)
  console.log(
    `  airports  ${theatre.padEnd(16)}  ${String(result.airportCount).padStart(3)} airports  ` +
    `${String(result.taxiCount).padStart(5)} taxiways  ` +
    `${String(result.rwyCount).padStart(3)} runways  ` +
    `${kb.padStart(6)} KB`
  )
}

function buildTowns(theatre, terrainsDir, outRoot) {
  const result = townsCore.buildTheatre({ theatre, terrainsDir })

  if (result.status === 'skip') {
    console.log(`  towns     ${theatre}: skipped — ${result.reason}`)
    return
  }

  const outDir = path.join(outRoot, 'towns')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(
    path.join(outDir, `${theatre}.json`),
    JSON.stringify({ theatre, towns: result.towns }, null, 1)
  )

  console.log(
    `  towns     ${theatre.padEnd(16)}  ${String(result.towns.length).padStart(3)} towns` +
    (result.skippedLines ? `  (${result.skippedLines} unparsed lines skipped)` : '')
  )
}

function main() {
  const args  = process.argv.slice(2)
  const outIdx = args.indexOf('--out')
  let outRoot = null
  if (outIdx !== -1) {
    outRoot = args[outIdx + 1]
    args.splice(outIdx, 2)
  }

  const installPath = args[0]
  const only        = args[1]

  if (!installPath) {
    console.error('Usage: TracsTerrainDataBuilder.exe <dcs-installation-path> [theatre] [--out <dir>]')
    console.error('  <dcs-installation-path>  DCS World install root, or its Mods\\terrains folder')
    process.exit(1)
  }

  const terrainsDir = resolveTerrainsDir(installPath)
  if (!terrainsDir) {
    console.error(`Could not find DCS terrain data under "${installPath}".`)
    console.error('Pass the DCS World install root (e.g. "...\\DCS World") or its Mods\\terrains folder.')
    process.exit(1)
  }

  if (only && !THEATRES[only]) {
    console.error(`Unknown theatre "${only}". Options: ${Object.keys(THEATRES).join(', ')}`)
    process.exit(1)
  }

  if (!outRoot) {
    const exeDir = isSeaBinary ? path.dirname(process.execPath) : process.cwd()
    outRoot = path.join(exeDir, 'terrain_data')
  }

  console.log('\nTRACS Terrain Data Builder\n')
  console.log(`DCS terrains: ${terrainsDir}`)
  console.log(`Output:       ${outRoot}\n`)

  const theatres = only ? [only] : Object.keys(THEATRES)
  for (const t of theatres) {
    buildAirports(t, terrainsDir, outRoot)
    buildTowns(t, terrainsDir, outRoot)
  }

  console.log('\nDone.\n')
}

main()
