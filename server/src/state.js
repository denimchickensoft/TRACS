'use strict'

const units = new Map()   // unitId (string) → unit object
const weapons = new Map() // weaponId (string) → weapon object — missiles only, see olympus.js's pollWeapons()/tacview.js
let mission   = null
let airbases  = []
let bullseyes = null
let lastUpdateTime = 0
let lastWeaponsUpdateTime = 0
let sourceType = 'olympus'

// Olympus's /olympus/units?time= endpoint needs its own opaque cursor —
// Olympus's returned `updateTime` (see decoder.js), echoed back verbatim on
// the next poll — completely different domain/meaning from lastUpdateTime
// above (last-broadcast bookkeeping, written by every applyDelta() call).
// Kept separate on purpose: olympus.js's pollMissileDetection() also calls
// applyDelta(), with a Date.now()-based delta.time that has nothing to do
// with Olympus's own clock — if that were allowed to overwrite the same
// field the incremental fetch cursor read from, it would silently corrupt
// pollUnits()'s next `?time=` request whenever a missile-detection delta
// landed in between two unit polls (seen as position stutter/jumps — any
// friendly AWACS/EWR alive is enough to trigger this, no missile needs to be
// in the air).
let sourceCursorTime = 0

function applyDelta(delta) {
  if (delta.updated) {
    for (const [id, unit] of Object.entries(delta.updated)) {
      units.set(id, { ...units.get(id), ...unit })
    }
  }
  if (delta.removed) {
    for (const id of delta.removed) {
      units.delete(id)
    }
  }
  lastUpdateTime = delta.time ?? Date.now()
}

function getSnapshot() {
  return {
    updated: Object.fromEntries(units),
    removed: [],
    time: lastUpdateTime,
  }
}

function applyWeaponsDelta(delta) {
  if (delta.updated) {
    for (const [id, weapon] of Object.entries(delta.updated)) {
      weapons.set(id, { ...weapons.get(id), ...weapon })
    }
  }
  if (delta.removed) {
    for (const id of delta.removed) {
      weapons.delete(id)
    }
  }
  lastWeaponsUpdateTime = delta.time ?? Date.now()
}

function getWeaponsSnapshot() {
  return {
    updated: Object.fromEntries(weapons),
    removed: [],
    time: lastWeaponsUpdateTime,
  }
}

// Called at the top of every source's start() -- a fresh source has no
// relation to whatever the previous source left behind, so every per-session
// field needs to go, not just units (a mission/airbases field lingering from
// a since-replaced source is a live cross-source data contradiction, e.g.
// Olympus's frameRate surviving into a Tacview session).
function resetForNewSource() {
  units.clear()
  weapons.clear()
  lastUpdateTime = 0
  lastWeaponsUpdateTime = 0
  sourceCursorTime = 0
  mission = null
  airbases = []
  bullseyes = null
}

module.exports = {
  applyDelta,
  getSnapshot,
  applyWeaponsDelta,
  getWeaponsSnapshot,
  resetForNewSource,
  getUnit:          (id) => units.get(String(id)),
  // [id, unit][] -- entries (not just values) so a caller gets the
  // authoritative map key directly, without relying on a unit object's own
  // id-shaped field staying in sync with it. Used by srs.js's name-based
  // correlation fallback.
  getAllUnitEntries: () => [...units.entries()],
  getAllWeaponEntries: () => [...weapons.entries()],
  getMission:       ()   => mission,
  setMission:       (m)  => { mission = m },
  getAirbases:      ()   => airbases,
  setAirbases:      (a)  => { airbases = a },
  getBullseyes:     ()   => bullseyes,
  setBullseyes:     (b)  => { bullseyes = b },
  getLastUpdateTime: ()  => sourceCursorTime,
  setSourceCursorTime: (t) => { sourceCursorTime = t },
  getSourceType:    ()   => sourceType,
  setSourceType:    (t)  => { sourceType = t },
}
