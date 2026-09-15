'use strict'

// Runtime lookup against client/public/units/weaponSensorDatabase.json (built
// by server/scripts/buildWeaponDatabase.js) — shared by both ingestion paths
// (olympus.js's pollWeapons(), tacviewCore.js's classify()) for the
// trackability threshold, and by missileDetection.js for the RCS input to its
// range-scaling formula. One shared module so all three agree on the same
// threshold and the same "not found" fallback, rather than each re-reading
// the file independently.
//
// Real-world sourced: cruise missiles with RCS <= 0.1 m^2 are "difficult for
// SAM fire-control radars to track" (Wikipedia: Radar cross-section) — fire-
// control radar is short-range/high-gain and more capable than a wide-area
// AWACS search radar, so 0.1 m^2 is a generous floor, not a conservative one.
// Applied against real datamine Reflection values this session: cleanly
// separates AAMs/AGMs/point-defense SAMs (Tor family, Buk-M2 — all < 0.1)
// from real medium/large threats (Harpoon, Hawk, Patriot, SA-2, SA-5 — all
// >= 0.1). See the "Add missile tracking to AIC/ABM" plan for the full
// investigation.
const TRACKABLE_RCS_THRESHOLD_M2 = 0.1

const fs = require('fs')
const path = require('path')

const DB_PATH = path.join(__dirname, '..', '..', 'client', 'public', 'units', 'weaponSensorDatabase.json')

let db = {}
try {
  db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'))
} catch {
  db = {}
}

// Real per-weapon RCS (m^2), or null if this weapon's name isn't in the
// database. Not-found is a real, expected outcome (e.g. a SAM round whose
// datamine link is unresolvable — see the plan's S-300/Tor/Tunguska/S-125
// investigation) — callers must treat null as "unknown," never fall back to
// a guessed default.
function getWeaponRcs(name) {
  return db[name]?.reflection ?? null
}

// Not found at all -> not trackable. Conservative default, no hand-maintained
// allowlist: an unresolved real-world weapon simply isn't trackable until its
// name is captured and its Reflection value added to the datamine-derived set.
function isTrackableMissile(name) {
  const rcs = getWeaponRcs(name)
  return rcs !== null && rcs >= TRACKABLE_RCS_THRESHOLD_M2
}

module.exports = { getWeaponRcs, isTrackableMissile, TRACKABLE_RCS_THRESHOLD_M2 }
