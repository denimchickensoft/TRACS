'use strict'

// Corrects runway designators (`name`) in client/public/runways/<Theatre>.json.
// The geometry in those files is trustworthy; DCS's own Airbase:getRunways()
// `Name` field is not.
//
// DCS fills `Name` from a flattened list of runway ends
// [r0.endA, r0.endB, r1.endA, r1.endB, ...], but indexes it by runway number
// instead of 2x runway number. So runway 0 is always right, and runway i >= 1
// gets an end designator belonging to runway floor(i/2). Single-runway and
// parallel-only airbases are unaffected, because every end they could be handed
// lies on the same axis.
//
// Rule 1 (the indexing bug): runway i >= 1 is renamed when its name isn't on its
// own axis, is on runway floor(i/2)'s axis, and the two runways point in
// different directions. The new designator comes from the runway's own
// geometry plus runway 0's offset (designator minus true axis). That offset
// carries the airbase's magnetic variation and whatever era DCS numbered it
// for, so no magnetic model is needed here.
//
// Rule 2 (bad runway 0): DCS occasionally exports a runway 0 that is simply
// wrong. Each theatre gets an era year fitted from its own runway 0s: for every
// year 1900-2030, count the runway 0s within 5 deg of (true axis - magnetic
// variation); the era year is the middle of the years tied for the highest
// count. Runway 0s more than 20 deg off at that year are excluded and the fit is
// repeated until it settles. Whatever is still more than 20 deg off is renamed
// from true axis minus magnetic variation at the era year.
//
// Renamed runways keep DCS's original value in `name_dcs`. Re-running is a
// no-op, and a fresh DCS export can be re-corrected by running this again.
//
// Usage:
//   npm run fix:runways --workspace=server            # all theatres
//   npm run fix:runways --workspace=server -- Syria   # one theatre
//   npm run fix:runways --workspace=server -- --dry-run

const fs   = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')

const RUNWAYS_DIR = path.join(__dirname, '..', '..', 'client', 'public', 'runways')
const MAGVAR_JS   = path.join(__dirname, '..', '..', 'client', 'src', 'utils', 'magvar.js')

const ERA_MATCH_DEG   = 5     // runway 0 counts toward a year when within this of the predicted axis
const BAD_RWY0_DEG    = 20    // runway 0 further off than this at the era year gets renamed
const OWN_AXIS_DEG    = 5     // name already on its own (calibrated) axis: leave it
const OTHER_AXIS_DEG  = 8     // name sits on runway floor(i/2)'s axis: bug candidate
const DIFFERENT_AXIS  = 15    // runways closer than this are treated as parallel
const YEAR_MIN = 1900
const YEAR_MAX = 2030

const args   = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const only   = args.filter(a => !a.startsWith('--'))

// Initial bearing end1 -> end2, degrees true.
function bearing(e1, e2) {
  const lat = ((e1.lat + e2.lat) / 2) * Math.PI / 180
  const dx  = (e2.lon - e1.lon) * Math.cos(lat)
  const dy  = e2.lat - e1.lat
  return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360
}

const signedDiff = (a, b) => ((a - b) % 360 + 540) % 360 - 180

// Smallest signed difference between heading a and either direction of axis b.
function axisDiff(a, b) {
  const d1 = signedDiff(a, b)
  const d2 = signedDiff(a, b + 180)
  return Math.abs(d1) <= Math.abs(d2) ? d1 : d2
}
const axisDist = (a, b) => Math.abs(axisDiff(a, b))

const toDesignator = hdg => {
  const n = Math.round((((hdg % 360) + 360) % 360) / 10) % 36
  return n === 0 ? 36 : n
}

// The runway's true heading in the direction DCS's course points (-course is
// the direction runway 0's name is given for), so a renamed runway keeps the
// same end as its primary designator.
function primaryHeading(rwy, trueAxis) {
  const dcsDir = ((-rwy.course_true_deg) % 360 + 360) % 360
  return Math.abs(signedDiff(trueAxis, dcsDir)) <= 90 ? trueAxis : (trueAxis + 180) % 360
}

function usableRunways(ab) {
  if (!Array.isArray(ab.runways)) return []
  return ab.runways.filter(r => r.end1 && r.end2 && r.name != null && r.course_true_deg != null)
}

function fitEraYear(rwy0s, computeMagvar) {
  const devAt = (r, y) => axisDist(r.name * 10, r.axis - computeMagvar(r.lat, r.lon, y))
  let set  = rwy0s
  let year = null
  for (;;) {
    let best = -1
    let tied = []
    for (let y = YEAR_MIN; y <= YEAR_MAX; y++) {
      const count = set.reduce((n, r) => n + (devAt(r, y) <= ERA_MATCH_DEG ? 1 : 0), 0)
      if (count > best) { best = count; tied = [y] }
      else if (count === best) tied.push(y)
    }
    const nextYear = Math.round((tied[0] + tied[tied.length - 1]) / 2)
    const nextSet  = rwy0s.filter(r => devAt(r, nextYear) <= BAD_RWY0_DEG)
    const settled  = nextYear === year && nextSet.length === set.length
    year = nextYear
    set  = nextSet
    if (settled || set.length === 0) break
  }
  return { year, devAt }
}

function rename(rwy, newName) {
  if (rwy.name === newName) return
  // Keep key order stable: name_dcs sits right after name.
  const hadDcsName = 'name_dcs' in rwy
  const entries = Object.entries(rwy)
  for (const k of Object.keys(rwy)) delete rwy[k]
  for (const [k, v] of entries) {
    rwy[k] = v
    if (k === 'name' && !hadDcsName) rwy.name_dcs = v
  }
  rwy.name = newName
}

function processTheatre(file, computeMagvar) {
  const raw  = fs.readFileSync(file, 'utf8')
  const data = JSON.parse(raw)
  const airbases = Array.isArray(data) ? data : data.airbases
  const changes  = []

  const bases = airbases
    .map(ab => {
      const rws = usableRunways(ab)
      return { ab, rws, axes: rws.map(r => bearing(r.end1, r.end2)) }
    })
    .filter(b => b.rws.length > 0)

  const rwy0s = bases.map(b => ({ b, name: b.rws[0].name, axis: b.axes[0], lat: b.rws[0].lat, lon: b.rws[0].lon }))
  const { year, devAt } = fitEraYear(rwy0s, computeMagvar)

  // Rule 2 first, so rule 1 calibrates from a corrected runway 0.
  for (const r of rwy0s) {
    const dev = devAt(r, year)
    if (dev <= BAD_RWY0_DEG) continue
    const rwy  = r.b.rws[0]
    const hdg  = primaryHeading(rwy, r.axis) - computeMagvar(rwy.lat, rwy.lon, year)
    const next = toDesignator(hdg)
    if (next === rwy.name) continue
    changes.push({ airbase: r.b.ab.airbase, index: 0, from: rwy.name, to: next, rule: `runway 0 ${dev.toFixed(0)} deg off at ${year}` })
    rename(rwy, next)
  }

  const unexplained = []
  for (const { ab, rws, axes } of bases) {
    if (rws.length < 2) continue
    const offset = axisDiff(rws[0].name * 10, axes[0])
    const designatorAxis = i => axes[i] + offset
    for (let i = 1; i < rws.length; i++) {
      const rwy = rws[i]
      const j   = Math.floor(i / 2)
      if (axisDist(rwy.name * 10, designatorAxis(i)) <= OWN_AXIS_DEG) continue
      const onOtherAxis = axisDist(rwy.name * 10, designatorAxis(j)) <= OTHER_AXIS_DEG
      const different   = axisDist(axes[i], axes[j]) > DIFFERENT_AXIS
      if (!onOtherAxis || !different) {
        const off = axisDist(rwy.name * 10, designatorAxis(i))
        if (off > BAD_RWY0_DEG) unexplained.push(`${ab.airbase} runway ${i} name ${rwy.name} is ${off.toFixed(0)} deg off`)
        continue
      }
      const next = toDesignator(primaryHeading(rwy, axes[i]) + offset)
      if (next === rwy.name) continue
      changes.push({ airbase: ab.airbase, index: i, from: rwy.name, to: next, rule: `carried runway ${j}'s designator` })
      rename(rwy, next)
    }
  }

  if (changes.length && !dryRun) {
    const indent = (raw.match(/\n( +)"/) || [null, '  '])[1]
    const trailingNewline = raw.endsWith('\n') ? '\n' : ''
    fs.writeFileSync(file, JSON.stringify(data, null, indent) + trailingNewline)
  }
  return { year, changes, unexplained, airbaseCount: bases.length }
}

async function main() {
  const { computeMagvar } = await import(pathToFileURL(MAGVAR_JS).href)
  const files = fs.readdirSync(RUNWAYS_DIR)
    .filter(f => f.endsWith('.json'))
    .filter(f => only.length === 0 || only.includes(path.basename(f, '.json')))
    .sort()

  let totalRunways = 0
  const touched = new Set()
  for (const f of files) {
    const { year, changes, unexplained, airbaseCount } = processTheatre(path.join(RUNWAYS_DIR, f), computeMagvar)
    const theatre = path.basename(f, '.json')
    console.log(`${theatre}: era year ${year}, ${airbaseCount} airbases, ${changes.length} runway(s) renamed`)
    for (const c of changes) {
      console.log(`  ${c.airbase} runway ${c.index}: ${c.from} -> ${c.to} (${c.rule})`)
      touched.add(`${theatre}|${c.airbase}`)
    }
    for (const u of unexplained) console.log(`  CHECK: ${u} (not renamed)`)
    totalRunways += changes.length
  }
  console.log(`${dryRun ? 'Dry run - nothing written. ' : ''}Total: ${touched.size} airbases, ${totalRunways} runways renamed`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
