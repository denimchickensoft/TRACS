'use strict'

// Builds per-theatre town/place label data for map-context rendering (ABM).
// Reads DCS's own map/towns.lua (the same data ED uses for F10 map labels)
// and writes client/public/towns/<Theatre>.json.
//
// Usage:
//   node server/scripts/buildTownLabels.js [theatre]
//   node server/scripts/buildTownLabels.js [--dcs-path <path>] [theatre]
//
// DCS terrain path defaults to the Steam installation. Override with --dcs-path.
//
// See also: server/scripts/terrainDataExe — a standalone .exe build of this
// same logic (via server/scripts/lib/townLabelsCore.js) for distribution to
// machines without this repo checked out.

const fs   = require('fs')
const path = require('path')
const core = require('./lib/townLabelsCore')

const ROOT       = path.join(__dirname, '../..')
const THEATRES   = JSON.parse(fs.readFileSync(path.join(__dirname, '../navdata/config/theatres.json'), 'utf8'))
const OUTPUT_DIR = path.join(ROOT, 'client/public/towns')

const DEFAULT_DCS_PATH = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\DCSWorld\\Mods\\terrains'

function buildAndWriteTheatre(theatre, dcsPath) {
  const dcsFolder = THEATRES[theatre]?.terrainsFolder
  const result = core.buildTheatre({ theatre, terrainsDir: dcsPath, dcsFolder })

  if (result.status === 'skip') {
    console.log(`  ${theatre}: skipped - ${result.reason}`)
    return
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  const outPath = path.join(OUTPUT_DIR, `${theatre}.json`)
  fs.writeFileSync(outPath, JSON.stringify({ theatre, towns: result.towns }, null, 1))
  console.log(`  ${theatre}: ${result.towns.length} towns written to ${path.relative(ROOT, outPath)}${result.skippedLines ? ` (${result.skippedLines} unparsed lines skipped)` : ''}`)
}

function main() {
  const args = process.argv.slice(2)
  let dcsPath = DEFAULT_DCS_PATH
  const dpIdx = args.indexOf('--dcs-path')
  if (dpIdx !== -1) {
    dcsPath = args[dpIdx + 1]
    args.splice(dpIdx, 2)
  }

  const theatres = args.length ? args : Object.keys(THEATRES)

  console.log(`DCS path: ${dcsPath}\n`)
  for (const t of theatres) buildAndWriteTheatre(t, dcsPath)
}

if (require.main === module) main()
