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

const fs   = require('fs')
const path = require('path')

const ROOT       = path.join(__dirname, '../..')
const THEATRES   = JSON.parse(fs.readFileSync(path.join(__dirname, '../navdata/config/theatres.json'), 'utf8'))
const OUTPUT_DIR = path.join(ROOT, 'client/public/towns')

const DEFAULT_DCS_PATH = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\DCSWorld\\Mods\\terrains'

const LINE_RE = /^\["(.+)"\]\s*=\s*\{\s*latitude\s*=\s*(-?[0-9.]+),\s*longitude\s*=\s*(-?[0-9.]+),\s*display_name\s*=\s*_\(".*"\)\s*\},?$/

function buildTheatre(theatre, dcsPath) {
  const luaPath = path.join(dcsPath, theatre, 'map', 'towns.lua')
  if (!fs.existsSync(luaPath)) {
    console.log(`  ${theatre}: skipped — towns.lua not found`)
    return
  }

  const lines = fs.readFileSync(luaPath, 'utf8').split(/\r?\n/)
  const towns = []
  let skipped = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('local') || trimmed === 'towns = {' || trimmed === '}') continue
    const m = LINE_RE.exec(trimmed)
    if (!m) { skipped++; continue }
    towns.push({ name: m[1], lat: parseFloat(m[2]), lon: parseFloat(m[3]) })
  }

  towns.sort((a, b) => a.name.localeCompare(b.name))

  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  const outPath = path.join(OUTPUT_DIR, `${theatre}.json`)
  fs.writeFileSync(outPath, JSON.stringify({ theatre, towns }, null, 1))
  console.log(`  ${theatre}: ${towns.length} towns written to ${path.relative(ROOT, outPath)}${skipped ? ` (${skipped} unparsed lines skipped)` : ''}`)
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
  for (const t of theatres) buildTheatre(t, dcsPath)
}

main()
