'use strict'

// Extracts real per-weapon RCS (Reflection, m^2) and physical size (Diam,
// mm; M, kg) from the Quaggles/dcs-lua-datamine project's archived Lua
// weapon definitions, and writes client/public/units/weaponSensorDatabase.json
// — a static, pre-generated artifact, same role as aircraftSensorDatabase.json
// (see buildAircraftSensorDb.js) but for in-flight weapon objects.
//
// Only scans missile-relevant folders — weapons_table/weapons/missiles/ and
// the top-level rockets/ folder — not bombs/shells: those are filtered out by
// category before the RCS lookup ever runs (see olympus.js's pollWeapons()/
// tacviewCore.js's classify()), so their entries would never be consulted.
//
// Both folders are required for real coverage, not redundant: every ground-
// launched SAM round captured live this session (SA2V755, SA5V28, SA9M330,
// SA9M338K) exists ONLY under rockets/, not weapons_table/weapons/missiles/.
// The two folders also overlap heavily (e.g. the AGM-65 family appears in
// both) — where a name exists in both, rockets/ (scanned second) wins, since
// both ultimately describe the same underlying DCS weapon and should agree.
//
// Like buildAircraftSensorDb.js, this reads the datamine's own extracted
// values rather than parsing a local DCS install directly — same rationale
// (the datamine's extraction method reads DCS's actual runtime values,
// covering weapons whose stats are compiled into the closed engine, not just
// ones shipped as readable Lua on this install).
//
// Usage:
//   node server/scripts/buildWeaponDatabase.js --datamine-path <path>
//
// --datamine-path is required, not defaulted — see buildAircraftSensorDb.js's
// comment for why (resources/ is gitignored, no default location can be
// assumed).
//
// The filename (minus .lua) IS the real DCS weapon `name` value in both
// folders — confirmed against every file checked live this session
// (AIM_120C.lua -> name="AIM_120C", SA5V28.lua -> name="SA5V28", etc.), no
// internal-field parsing needed for the key itself.

const fs   = require('fs')
const path = require('path')

const ROOT      = path.join(__dirname, '../..')
const UNITS_DIR = path.join(ROOT, 'client/public/units')
const OUT_PATH  = path.join(UNITS_DIR, 'weaponSensorDatabase.json')

// Matched anywhere in the file, not anchored to a specific nesting level —
// weapons_table/weapons/missiles/*.lua files nest these fields inside
// client={}/server={} sub-tables (usually duplicated identically in both),
// while rockets/*.lua files are flatter and carry them at the top level.
// Taking the first match anywhere handles both shapes without needing to
// know which one a given file uses.
const REFLECTION_RE    = /^[ \t]*Reflection[ \t]*=[ \t]*([\d.]+)/m
const DIAM_RE          = /^[ \t]*Diam[ \t]*=[ \t]*([\d.]+)/m
const MASS_RE          = /^[ \t]*M[ \t]*=[ \t]*([\d.]+)/m
const DISPLAY_NAME_RE  = /^[ \t]*display_name[ \t]*=[ \t]*['"]([^'"]+)['"]/m

function loadWeaponDir(dir) {
  const result = {}
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    console.warn(`  warn: cannot read ${dir} (${err.code ?? err.message})`)
    return result
  }
  for (const dirent of entries) {
    if (!dirent.isFile() || !dirent.name.toLowerCase().endsWith('.lua')) continue
    const name = dirent.name.slice(0, -'.lua'.length)
    let src
    try {
      src = fs.readFileSync(path.join(dir, dirent.name), 'utf8')
    } catch (err) {
      console.warn(`  warn: cannot read ${path.join(dir, dirent.name)} (${err.code ?? err.message})`)
      continue
    }
    const reflectionM = src.match(REFLECTION_RE)
    if (!reflectionM) continue // no RCS data in this file — can't be used for the trackability threshold
    const diamM        = src.match(DIAM_RE)
    const massM        = src.match(MASS_RE)
    const displayNameM = src.match(DISPLAY_NAME_RE)
    result[name] = {
      reflection: parseFloat(reflectionM[1]),
      diamMm: diamM ? parseFloat(diamM[1]) : null,
      massKg: massM ? parseFloat(massM[1]) : null,
      displayName: displayNameM ? displayNameM[1] : null,
      sourceFile: path.relative(path.dirname(dir), path.join(dir, dirent.name)),
    }
  }
  return result
}

function main() {
  const args = process.argv.slice(2)
  const dpIdx = args.indexOf('--datamine-path')
  if (dpIdx === -1) {
    console.error('error: --datamine-path <path> is required (resources/ is gitignored - no default location can be assumed)')
    console.error('usage: node server/scripts/buildWeaponDatabase.js --datamine-path <path>')
    process.exit(1)
  }
  const datamineRoot = args[dpIdx + 1]

  console.log(`Datamine path: ${datamineRoot}\n`)
  if (!fs.existsSync(datamineRoot)) {
    console.error(`error: ${datamineRoot} does not exist`)
    process.exit(1)
  }

  const missilesDir = path.join(datamineRoot, 'weapons_table', 'weapons', 'missiles')
  const rocketsDir   = path.join(datamineRoot, 'rockets')

  const fromMissiles = loadWeaponDir(missilesDir)
  console.log(`Read ${Object.keys(fromMissiles).length} entries with Reflection data from weapons_table/weapons/missiles/`)

  const fromRockets = loadWeaponDir(rocketsDir)
  console.log(`Read ${Object.keys(fromRockets).length} entries with Reflection data from rockets/`)

  // rockets/ wins on overlap — see file header for why this is safe.
  const merged = { ...fromMissiles, ...fromRockets }
  console.log(`\n${Object.keys(merged).length} unique weapon name(s) resolved`)

  const sorted = {}
  for (const key of Object.keys(merged).sort()) sorted[key] = merged[key]

  const outDir = path.dirname(OUT_PATH)
  fs.mkdirSync(outDir, { recursive: true })
  const tmpPath = OUT_PATH + '.tmp'
  fs.writeFileSync(tmpPath, JSON.stringify(sorted, null, 1))
  fs.renameSync(tmpPath, OUT_PATH)
  console.log(`Written to ${path.relative(ROOT, OUT_PATH)}`)
}

if (require.main === module) main()
