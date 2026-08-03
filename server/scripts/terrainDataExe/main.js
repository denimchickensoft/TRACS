'use strict'

// TRACS Terrain Data Builder — standalone CLI.
//
// Bundled by esbuild into a single CJS file and packaged as a Windows .exe
// via Node's Single Executable Application (SEA) support, so it can run on a
// machine that only has a DCS World install and no copy of this repo.
//
// The .exe is just the engine — it carries no baked-in theatre data. All of
// that (theatres.json, projection_params.json, airport_name_map.json, and a
// runways/ folder of per-theatre runway JSON) lives in a "manifest" folder
// next to the .exe, read fresh on every run. `build.js` seeds dist/manifest
// from the current repo state on every build, so a fresh build works out of
// the box — but afterwards, adding a new theatre or fixing a theatre's
// projection params, on-disk folder name, or runway data is just editing
// files in manifest/, no rebuild required. Rebuilding is only needed when
// the engine logic itself (this file, or server/scripts/lib/*Core.js) changes.
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
// The whole <out> tree is also packed into a single "<out>.zip" alongside it,
// so the result is one file to hand back rather than a scattered folder.

const fs         = require('fs')
const path       = require('path')
const airportCore  = require('../lib/airportPolygonsCore')
const townsCore     = require('../lib/townLabelsCore')
const { buildZip }  = require('../lib/zipWriter')

let isSeaBinary = false
try { isSeaBinary = require('node:sea').isSea() } catch { /* Node < 21, or not built as SEA */ }

function exeDir() {
  return isSeaBinary ? path.dirname(process.execPath) : process.cwd()
}

function loadJson(p, label, { required }) {
  if (!fs.existsSync(p)) {
    if (required) {
      console.error(`Missing required manifest file: ${p}`)
      process.exit(1)
    }
    return null
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (e) {
    console.error(`Could not parse ${label} (${p}): ${e.message}`)
    process.exit(1)
  }
}

function loadManifest(manifestDir) {
  if (!fs.existsSync(manifestDir)) {
    console.error(`Could not find a manifest folder at ${manifestDir}.`)
    console.error('The engine needs theatres.json, projection_params.json, and a runways/ folder')
    console.error('next to the .exe — a fresh build seeds these under dist/manifest.')
    process.exit(1)
  }

  const theatres  = loadJson(path.join(manifestDir, 'theatres.json'), 'theatres.json', { required: true })
  const tmParams  = loadJson(path.join(manifestDir, 'projection_params.json'), 'projection_params.json', { required: true })
  const nameMap   = loadJson(path.join(manifestDir, 'airport_name_map.json'), 'airport_name_map.json', { required: false }) || {}

  return { theatres, tmParams, nameMap, runwaysDir: path.join(manifestDir, 'runways') }
}

function loadRunwayJson(runwaysDir, rwKey) {
  const p = path.join(runwaysDir, `${rwKey}.json`)
  if (!fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (e) {
    console.error(`Warning: could not parse runway JSON ${p}: ${e.message}`)
    return null
  }
}

function resolveTerrainsDir(installPath, theatres) {
  const candidates = [
    path.join(installPath, 'Mods', 'terrains'),
    path.join(installPath, 'terrains'),
    installPath,
  ]
  for (const dir of candidates) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue
    const hasTheatre = Object.keys(theatres).some(t => fs.existsSync(path.join(dir, theatres[t].terrainsFolder || t)))
    if (hasTheatre) return dir
  }
  return null
}

function buildAirports(theatre, terrainsDir, outRoot, manifest) {
  const { theatres, tmParams, nameMap, runwaysDir } = manifest
  const tm      = tmParams[theatre]
  const nMap    = nameMap[theatre] || {}
  const conf    = theatres[theatre]
  const rwKey   = conf.runwayKey || theatre
  const rwJson  = loadRunwayJson(runwaysDir, rwKey)

  const result = airportCore.buildTheatre({ theatre, terrainsDir, tm, nameMap: nMap, conf, rwJson })

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
      `            ${result.unmatchedStems.length} rn5 stems have no airport_name_map entry, ` +
      `${result.unclaimedAirbases.length} runway-JSON airbases unclaimed, ` +
      `${result.suggestedPairs.length} suggested by location -> unmatched_airports.json`
    )
  }
}

function buildTowns(theatre, terrainsDir, outRoot, manifest) {
  const dcsFolder = manifest.theatres[theatre].terrainsFolder
  const result = townsCore.buildTheatre({ theatre, terrainsDir, dcsFolder })

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

function collectFiles(dir, baseDir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectFiles(full, baseDir, out)
    else if (entry.isFile()) out.push({ name: path.relative(baseDir, full), data: fs.readFileSync(full) })
  }
  return out
}

function zipOutput(outRoot) {
  if (!fs.existsSync(outRoot)) return null
  const files = collectFiles(outRoot, outRoot)
  if (!files.length) return null
  const zipPath = `${outRoot}.zip`
  fs.writeFileSync(zipPath, buildZip(files))
  return { zipPath, count: files.length }
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

  const dir = exeDir()
  const manifest = loadManifest(path.join(dir, 'manifest'))
  const { theatres } = manifest

  const terrainsDir = resolveTerrainsDir(installPath, theatres)
  if (!terrainsDir) {
    console.error(`Could not find DCS terrain data under "${installPath}".`)
    console.error('Pass the DCS World install root (e.g. "...\\DCS World") or its Mods\\terrains folder.')
    process.exit(1)
  }

  if (only && !theatres[only]) {
    console.error(`Unknown theatre "${only}". Options: ${Object.keys(theatres).join(', ')}`)
    process.exit(1)
  }

  if (!outRoot) outRoot = path.join(dir, 'terrain_data')

  console.log('\nTRACS Terrain Data Builder\n')
  console.log(`DCS terrains: ${terrainsDir}`)
  console.log(`Output:       ${outRoot}\n`)

  const list = only ? [only] : Object.keys(theatres)
  for (const t of list) {
    buildAirports(t, terrainsDir, outRoot, manifest)
    buildTowns(t, terrainsDir, outRoot, manifest)
  }

  const zipped = zipOutput(outRoot)
  if (zipped) {
    console.log(`\nZipped ${zipped.count} files -> ${zipped.zipPath}`)
  }

  console.log('\nDone.\n')
}

main()
