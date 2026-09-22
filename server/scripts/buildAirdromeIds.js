'use strict'

// Builds per-theatre numeric DCS airdromeId -> airbase name tables, used by
// the ABM ATO/FRAG panels to resolve a route waypoint's `airdromeId` field
// into a readable name. DCS's Mission Editor auto-assigns this numeric ID
// per theatre with no officially published table — the community-maintained
// pydcs project (github.com/pydcs/dcs) transcribes it per-theatre in
// dcs/terrain/<folder>/airports.py as `class X(Airport): id = N; name = "..."`.
// Verified against a real mission: PersianGulf id=4 -> "Al Dhafra AFB" matches
// an actual airdromeId=4 waypoint in resources/Operation Hormuz M05.miz.
//
// Usage: node server/scripts/buildAirdromeIds.js --pydcs-path <path>
// Writes: client/public/airdromes/<Theatre>.json  ({ "<id>": "<name>", ... })
//
// --pydcs-path is required, not defaulted — it points at a local checkout of
// pydcs (e.g. resources/pydcs-master, gitignored). resources/ isn't part of
// the committed project, so this script never assumes any specific
// resources/ subfolder name/location exists — the caller always says where
// their own local copy lives.

const fs   = require('fs')
const path = require('path')

const args  = process.argv.slice(2)
const ppIdx = args.indexOf('--pydcs-path')
if (ppIdx === -1) {
  console.error('error: --pydcs-path <path> is required (resources/ is gitignored - no default location can be assumed)')
  console.error('usage: node server/scripts/buildAirdromeIds.js --pydcs-path <path>')
  process.exit(1)
}

const ROOT      = path.join(__dirname, '../..')
const PYDCS_DIR = path.join(args[ppIdx + 1], 'dcs/terrain')
const OUT_DIR   = path.join(ROOT, 'client/public/airdromes')

// pydcs terrain folder name -> TRACS theatre name (matches projection_params.json keys)
const THEATRE_FOLDERS = {
  caucasus:       'Caucasus',
  falklands:      'SouthAtlantic',
  germany:        'Germany',
  kola:           'Kola',
  marianaislands: 'MarianaIslands',
  nevada:         'Nevada',
  normandy:       'Normandy',
  persiangulf:    'PersianGulf',
  sinai:          'Sinai',
  syria:          'Syria',
  thechannel:     'TheChannel',
}

const ID_NAME_RE = /\bid\s*=\s*(\d+)\s*\n\s*name\s*=\s*"([^"]*)"/g

function extractAirports(pySrc) {
  const out = {}
  for (const m of pySrc.matchAll(ID_NAME_RE)) {
    out[m[1]] = m[2]
  }
  return out
}

fs.mkdirSync(OUT_DIR, { recursive: true })

for (const [folder, theatre] of Object.entries(THEATRE_FOLDERS)) {
  const pyPath = path.join(PYDCS_DIR, folder, 'airports.py')
  if (!fs.existsSync(pyPath)) {
    console.log(`  ${theatre}: skipped - ${pyPath} not found`)
    continue
  }
  const src = fs.readFileSync(pyPath, 'utf8')
  const airports = extractAirports(src)
  const count = Object.keys(airports).length
  if (count === 0) {
    console.log(`  ${theatre}: skipped - no id/name pairs found`)
    continue
  }
  fs.writeFileSync(path.join(OUT_DIR, `${theatre}.json`), JSON.stringify(airports))
  console.log(`  ${theatre}: ${count} airbases`)
}
