'use strict'

// In-memory unit state. The browser is never the authority on unit data —
// this is the single source of truth on the server side.

const units = new Map()   // unitId (string) → unit object
let mission = null        // { bullseyes, theatre, commandMode, ... }
let airbases = []
let lastUpdateTime = 0

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

function clearUnits() {
  units.clear()
  lastUpdateTime = 0
}

module.exports = {
  applyDelta,
  getSnapshot,
  clearUnits,
  getUnit:          (id) => units.get(String(id)),
  getMission:       ()   => mission,
  setMission:       (m)  => { mission = m },
  getAirbases:      ()   => airbases,
  setAirbases:      (a)  => { airbases = a },
  getLastUpdateTime: ()  => lastUpdateTime,
}
