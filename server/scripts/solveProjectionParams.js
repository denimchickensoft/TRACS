'use strict'

// Solves TM projection params (central_meridian/false_easting/false_northing)
// for theatres missing from server/navdata/config/projection_params.json,
// from a ProjectionExports dump captured by resources/runway_and_projection_export.lua
// (in-game: writes Saved Games/DCS/ProjectionExports/<theatre>.json on mission
// load — zero point {x:0,y:0,z:0} plus every airbase's raw {x,y,z} paired with
// coord.LOtoLL's lat/lon). Drop that file at resources/<Theatre>.json and run
// this against it.
//
// Method matches pydcs's tools/export_map_projection.py: scale_factor is
// 0.9996 for every DCS theatre; central_meridian is one of the 60 UTM zone
// meridians (-177..177 step 6) and can't be derived any other way (DCS
// terrains don't always use the zone nearest their bbox center — e.g. Kola
// uses 21 despite spanning lon 12-41). For each candidate meridian, project
// the zero point with false_easting/false_northing at 0 — the residual *is*
// -false_easting/-false_northing. Validate that candidate against every
// airbase point; the one with ~zero round-trip error wins.
//
// Reuses this codebase's own Karney-series TM math (the shared tracs-geo-math
// workspace package) rather than pyproj, so the solved params are exact
// for the same projection the app actually renders with — no second
// implementation to drift out of sync. Axis convention (see dcsCoords.js):
// DCS x (north-south) -> northing, DCS z -> easting.
//
// Usage:
//   node server/scripts/solveProjectionParams.js --dump-dir <path>            # all <path>/*.json not yet in projection_params.json
//   node server/scripts/solveProjectionParams.js --dump-dir <path> Iraq        # one theatre
//
// --dump-dir is required, not defaulted — it's wherever the caller has
// dropped their own captured <Theatre>.json dumps (e.g. resources/,
// gitignored — not part of the committed project, so this never assumes
// that or any other specific resources/ location exists).

const fs   = require('fs')
const path = require('path')

const args     = process.argv.slice(2)
const ddIdx    = args.indexOf('--dump-dir')
if (ddIdx === -1) {
  console.error('error: --dump-dir <path> is required (resources/ is gitignored — no default location can be assumed)')
  console.error('usage: node server/scripts/solveProjectionParams.js --dump-dir <path> [theatre]')
  process.exit(1)
}
const RESOURCES_DIR = args[ddIdx + 1]
args.splice(ddIdx, 2)

const PARAMS_PATH    = path.join(__dirname, '../navdata/config/projection_params.json')

const SCALE_FACTOR = 0.9996
const UTM_MERIDIANS = []
for (let m = -177; m <= 177; m += 6) UTM_MERIDIANS.push(m)

// Meters — dumped values are Lua '%.8g'-formatted, so real-world points carry
// ~1m rounding on their own; a good central meridian reproduces every point
// far tighter than a wrong one (which is off by tens to hundreds of km).
const TOLERANCE_M = 10

function loadDump(theatre) {
  const p = path.join(RESOURCES_DIR, `${theatre}.json`)
  if (!fs.existsSync(p)) return null
  const data = JSON.parse(fs.readFileSync(p, 'utf8'))
  if (!data.zero || !Array.isArray(data.points)) return null
  return data
}

// Max easting/northing error (meters) reprojecting every dumped point through
// the candidate params; null points (failed coord.LOtoLL calls, if any got
// through) are skipped.
function maxError(tmForward, points, params) {
  let worst = 0
  for (const pt of points) {
    const { easting, northing } = tmForward(pt.lat, pt.lon, params)
    const errEasting  = Math.abs(easting  - pt.z)
    const errNorthing = Math.abs(northing - pt.x)
    worst = Math.max(worst, errEasting, errNorthing)
  }
  return worst
}

function solve(tmForward, dump) {
  const { zero, points } = dump
  let best = null

  for (const central_meridian of UTM_MERIDIANS) {
    const raw = tmForward(zero.lat, zero.lon, {
      central_meridian, false_easting: 0, false_northing: 0, scale_factor: SCALE_FACTOR,
    })
    const params = {
      central_meridian,
      false_easting:  -raw.easting,
      false_northing: -raw.northing,
      scale_factor:   SCALE_FACTOR,
    }

    const err = maxError(tmForward, points, params)
    if (!best || err < best.err) best = { params, err }
  }

  return best
}

async function main() {
  const only = args[0]

  const existing = JSON.parse(fs.readFileSync(PARAMS_PATH, 'utf8'))
  const { tmForward } = await import('tracs-geo-math')

  const candidates = only
    ? [only]
    : fs.readdirSync(RESOURCES_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5))
        .filter((t) => !(t in existing))

  if (!candidates.length) {
    console.log(`Nothing to solve — no ${RESOURCES_DIR}/<Theatre>.json without an existing projection_params.json entry.`)
    return
  }

  console.log('\nSolving TM projection parameters\n')

  let wrote = false
  const solvedNow = []
  for (const theatre of candidates) {
    const dump = loadDump(theatre)
    if (!dump) {
      console.log(`${theatre.padEnd(16)}  skipped — ${RESOURCES_DIR}/${theatre}.json missing or not a projection dump`)
      continue
    }

    const { params, err } = solve(tmForward, dump)
    const ok = err <= TOLERANCE_M
    console.log(
      `${theatre.padEnd(16)}  central_meridian=${params.central_meridian}  ` +
      `max round-trip error ${err.toFixed(2)}m across ${dump.points.length} airbases  ` +
      `${ok ? 'OK' : 'REJECTED (over tolerance)'}`
    )

    if (ok) {
      existing[theatre] = params
      solvedNow.push(theatre)
      wrote = true
    }
  }

  if (wrote) {
    // Drop solved names out of the TODO note; remove it entirely once empty.
    // Only the theatre-list clause (between "for:" and the next period) is
    // parsed — splitting the whole sentence on every comma would also cut up
    // the boilerplate that follows it.
    const todo = existing._TODO_missing_theatres || ''
    const listMatch = todo.match(/for:\s*([^.]+)\./)
    const remaining = listMatch
      ? listMatch[1].split(/,\s*/).map((s) => s.trim()).filter((t) => t && !solvedNow.includes(t))
      : []
    if (remaining.length) {
      existing._TODO_missing_theatres =
        `Runway JSON exists (see client/public/runways/) but no TM projection params have been mined yet for: ${remaining.join(', ')}. Until an entry is added here (central_meridian/false_easting/false_northing/scale_factor), terrainDataExe skips these theatres with reason 'no TM params or theatre config'.`
    } else {
      delete existing._TODO_missing_theatres
    }

    fs.writeFileSync(PARAMS_PATH, JSON.stringify(existing, null, 2) + '\n')
    console.log(`\nWrote ${PARAMS_PATH}`)
  }

  console.log('\nDone.\n')
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1) })
