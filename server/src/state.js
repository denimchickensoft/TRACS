'use strict'

const units = new Map()   // unitId (string) → unit object
let mission   = null
let airbases  = []
let bullseyes = null
let lastUpdateTime = 0
let sourceType = 'olympus'

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

// Called at the top of every source's start() -- a fresh source has no
// relation to whatever the previous source left behind, so every per-session
// field needs to go, not just units (a mission/airbases field lingering from
// a since-replaced source is a live cross-source data contradiction, e.g.
// Olympus's frameRate surviving into a Tacview session).
function resetForNewSource() {
  units.clear()
  lastUpdateTime = 0
  mission = null
  airbases = []
  bullseyes = null
}

module.exports = {
  applyDelta,
  getSnapshot,
  resetForNewSource,
  getUnit:          (id) => units.get(String(id)),
  // [id, unit][] -- entries (not just values) so a caller gets the
  // authoritative map key directly, without relying on a unit object's own
  // id-shaped field staying in sync with it. Used by srs.js's name-based
  // correlation fallback.
  getAllUnitEntries: () => [...units.entries()],
  getMission:       ()   => mission,
  setMission:       (m)  => { mission = m },
  getAirbases:      ()   => airbases,
  setAirbases:      (a)  => { airbases = a },
  getBullseyes:     ()   => bullseyes,
  setBullseyes:     (b)  => { bullseyes = b },
  getLastUpdateTime: ()  => lastUpdateTime,
  getSourceType:    ()   => sourceType,
  setSourceType:    (t)  => { sourceType = t },
}
