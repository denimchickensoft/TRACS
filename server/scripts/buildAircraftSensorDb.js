'use strict'

// Extracts real per-airframe RCS (radar cross-section, m^2) and
// detection_range_max (km, range against a "large" reference target) from
// the Quaggles/dcs-lua-datamine project's archived Lua unit definitions, and
// writes client/public/units/aircraftSensorDatabase.json — a static,
// pre-generated artifact (like groundunitdatabase.json/navyunitdatabase.json),
// not something the running server reads live at runtime.
//
// Why the datamine, not this machine's local DCS install: an earlier version
// of this script parsed CoreMods/aircraft/*/*.lua directly, which required
// reverse-engineering five separate, increasingly fragile Lua authoring
// idioms (dofile() inheritance chains, template functions with the name
// passed as a call argument, module-level local-variable names, dot-prefixed
// table-field overrides, same-line table-constructor fields) just to reach
// ~84 of 165 known aircraft/helicopters — and the other ~81 (the classic free
// "Flaming Cliffs"-era AI roster: MiGs, Sukhois, Tornado, big bombers, etc.)
// turned out to have their stats compiled into DCS's closed engine, not
// shipped as readable Lua at all on this install, no matter how much further
// parsing effort went in. The datamine's own extraction method reads DCS's
// actual runtime values directly (not parsing shipped source text), so it
// covers both cases in one mechanism — confirmed by 3-for-3 exact agreement
// against this script's own already-validated local-extraction values
// (F-16C_50, KJ-2000, A-10A) before switching over.
//
// Usage:
//   node server/scripts/buildAircraftSensorDb.js --datamine-path <path>
//
// --datamine-path is required, not defaulted — it points at a local copy of
// the datamine (e.g. resources/Lua Datamine, gitignored — a local reference
// dataset, same role resources/pydcs-master plays for buildAirdromeIds.js).
// resources/ is gitignored and not part of the committed project, so unlike
// DEFAULT_DCS_PATH-style scripts (which default to a well-known *external*
// system install location), this script must never assume any specific
// resources/ subfolder name/location exists — the caller always says where
// their own local copy lives.
//
// Walks every *.lua file directly under <path>/db/Units/Planes/Plane/ and
// <path>/db/Units/Helicopters/Helicopter/ — the filename (minus .lua) IS the
// real DCS unit Name, no Name-parsing needed at all, unlike the old
// local-install approach.
//
// Known, expected gap: client/public/units/aircraftdatabase.json has some
// keys (e.g. "F-16C bl.50") that aren't real DCS `Name` values (confirmed:
// these are RWR-classification hint text / encyclopedia reference labels,
// not real spawnable unit types) — those simply get no entry here and fall
// back to tacviewDetection.js's existing role-tier system. Not a bug.

const fs   = require('fs')
const path = require('path')

const ROOT      = path.join(__dirname, '../..')
const UNITS_DIR = path.join(ROOT, 'client/public/units')
const OUT_PATH  = path.join(UNITS_DIR, 'aircraftSensorDatabase.json')


const RCS_RE  = /^[ \t]*RCS[ \t]*=[ \t]*([\d.]+)/m
const DRM_RE  = /^[ \t]*detection_range_max[ \t]*=[ \t]*([\d.]+)/m
// Some real DCS unit Names contain a `/` (e.g. "F/A-18A"), which the
// datamine's own extraction sanitizes out of the filename (saved as
// "FA-18A.lua") while the file's own internal `Name = "F/A-18A"` field keeps
// the true value. Captures every such internal Name occurrence as an alias
// for the same file's rcs/drm — safe to be broad here (this also matches
// unrelated nested fields like `Name = "CAP"`/`Name = "AircraftCarrier..."`)
// since every alias still has to pass the real aircraftdatabase.json/
// helicopterdatabase.json key filter below before being kept.
const NAME_RE = /^[ \t]*Name[ \t]*=[ \t]*['"]([^'"]+)['"]/gm

// Highest legitimate detection_range_max seen across every module checked
// this session was 500 (KJ-2000/E-3A, AWACS-class platforms) — comfortably
// covers other large-airframe/AWACS-class values with real headroom.
const MAX_PLAUSIBLE_DETECTION_RANGE_KM = 1000

// A few datamine entries have a confirmed-implausible detection_range_max
// (H-6J: 400000, WingLoong-I/RQ-1A Predator: 10000 — 400-2000x every other
// legitimate value, and for H-6J directly contradicting live "walls test"
// flight data showing zero real radar-detection ticks all session). Rather
// than guess a "corrected" number, substitute a comparable real airframe's
// already-resolved value — reasoning per entry, not arbitrary:
// - H-6J (large strategic bomber, no real air-to-air radar per live flight
//   data) -> Tu-95MS/B-52H, the same class of large radar-less bomber.
// - WingLoong-I / RQ-1A Predator (MALE-class UAVs, no real radar) -> MQ-9
//   Reaper, the closest real analog (same drone lineage/role).
const SUBSTITUTE_FROM = {
  'H-6J': ['Tu-95MS', 'B-52H'],
  'WingLoong-I': ['MQ-9 Reaper'],
  'RQ-1A Predator': ['MQ-9 Reaper'],
}

// Confirmed WRONG via direct live-flight cross-validation, not a
// plausibility-cap case — these values are individually
// sane (150km, well within range), just empirically incorrect. Three
// separate F-14 units independently converged on ~189.5-189.8nm real
// detection range against a Tu-142 in the same live session: F-14A-135-GR
// (~189.6nm), F-14A-135-GR-Early (~189.8nm), F-14B (~189.5nm) — a tight
// cluster, not a spread, arguing DCS doesn't meaningfully vary this radar's
// range across the A/B variant line. But the datamine's own per-variant
// files for all three carry detectionRangeMaxKm=150 (predicting only
// ~81nm — a clear mismatch), while the untagged generic `F-14A` entry
// carries 350 (predicting ~189.0nm — an almost exact match). Overrides all
// three to the validated value, regardless of what their own per-variant
// datamine file says.
const LIVE_DATA_CORRECTIONS = {
  'F-14A-135-GR': 'F-14A',
  'F-14A-135-GR-Early': 'F-14A',
  'F-14B': 'F-14A',
}

function loadKnownUnitNames() {
  const names = new Set()
  for (const filename of ['aircraftdatabase.json', 'helicopterdatabase.json']) {
    const db = JSON.parse(fs.readFileSync(path.join(UNITS_DIR, filename), 'utf8'))
    for (const key of Object.keys(db)) names.add(key)
  }
  return names
}

// Reads every *.lua file directly under `dir`, keyed by filename (minus
// .lua) — that filename IS the real DCS unit Name in this datamine's layout,
// confirmed against every file spot-checked this session.
function loadDatamineDir(dir) {
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
    const rcsM = src.match(RCS_RE)
    const drmM = src.match(DRM_RE)
    if (!rcsM || !drmM) continue
    const parsed = { rcs: parseFloat(rcsM[1]), detectionRangeMaxKm: parseFloat(drmM[1]), sourceFile: dirent.name }
    result[name] = parsed
    for (const m of src.matchAll(NAME_RE)) {
      if (m[1] !== name && !result[m[1]]) result[m[1]] = parsed
    }
  }
  return result
}

function main() {
  const args = process.argv.slice(2)
  const dpIdx = args.indexOf('--datamine-path')
  if (dpIdx === -1) {
    console.error('error: --datamine-path <path> is required (resources/ is gitignored - no default location can be assumed)')
    console.error('usage: node server/scripts/buildAircraftSensorDb.js --datamine-path <path>')
    process.exit(1)
  }
  const datamineRoot = args[dpIdx + 1]
  args.splice(dpIdx, 2)

  console.log(`Datamine path: ${datamineRoot}\n`)
  if (!fs.existsSync(datamineRoot)) {
    console.error(`error: ${datamineRoot} does not exist`)
    process.exit(1)
  }

  const unitsDir = path.join(datamineRoot, 'db', 'Units')
  const planes = loadDatamineDir(path.join(unitsDir, 'Planes', 'Plane'))
  const helicopters = loadDatamineDir(path.join(unitsDir, 'Helicopters', 'Helicopter'))
  const raw = { ...planes, ...helicopters }
  console.log(`Read ${Object.keys(planes).length} plane files, ${Object.keys(helicopters).length} helicopter files with RCS/detection_range_max`)

  const knownNames = loadKnownUnitNames()
  const result = {}
  let discarded = 0
  let implausible = 0
  for (const [name, entry] of Object.entries(raw)) {
    if (!knownNames.has(name)) { discarded++; continue }
    if (entry.detectionRangeMaxKm > MAX_PLAUSIBLE_DETECTION_RANGE_KM) {
      console.warn(`  warn: "${name}" detectionRangeMaxKm=${entry.detectionRangeMaxKm} exceeds plausibility cap (${MAX_PLAUSIBLE_DETECTION_RANGE_KM}km) - not using directly, will try a substitute`)
      implausible++
      continue
    }
    result[name] = { rcs: entry.rcs, detectionRangeMaxKm: entry.detectionRangeMaxKm, sourceFile: entry.sourceFile }
  }
  console.log(`Discarded ${discarded} name(s) not present in aircraftdatabase.json/helicopterdatabase.json; ${implausible} implausible value(s) set aside for substitution`)

  for (const [name, candidates] of Object.entries(SUBSTITUTE_FROM)) {
    if (result[name]) continue
    for (const candidate of candidates) {
      if (!result[candidate]) continue
      result[name] = { rcs: result[candidate].rcs, detectionRangeMaxKm: result[candidate].detectionRangeMaxKm, sourceFile: `substitute:${candidate}` }
      console.log(`  substituted "${name}" <- "${candidate}" (own value unavailable or implausible)`)
      break
    }
  }

  for (const [name, sourceName] of Object.entries(LIVE_DATA_CORRECTIONS)) {
    const source = result[sourceName]
    if (!source) { console.warn(`  warn: cannot apply live-data correction for "${name}" - "${sourceName}" not resolved`); continue }
    result[name] = { rcs: source.rcs, detectionRangeMaxKm: source.detectionRangeMaxKm, sourceFile: `corrected:${sourceName} (confirmed via live walls-test data)` }
    console.log(`  corrected "${name}" <- "${sourceName}" (live-data cross-validation, overriding own datamine value)`)
  }

  console.log(`\n${Object.keys(result).length} of ${knownNames.size} known aircraft/helicopter names resolved`)

  const sorted = {}
  for (const key of Object.keys(result).sort()) sorted[key] = result[key]

  const outDir = path.dirname(OUT_PATH)
  fs.mkdirSync(outDir, { recursive: true })
  const tmpPath = OUT_PATH + '.tmp'
  fs.writeFileSync(tmpPath, JSON.stringify(sorted, null, 1))
  fs.renameSync(tmpPath, OUT_PATH)
  console.log(`Written to ${path.relative(ROOT, OUT_PATH)}`)
}

if (require.main === module) main()
