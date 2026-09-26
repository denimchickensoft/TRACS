import { hasLiveSquawk } from '../../../utils/transponder.js'

const METERS_TO_FEET = 3.28084

// Each entry: { sym: string, mine: boolean }
// sym  — '*' unassociated (beacon code received), 'V' unassociated
// squawking 1200, position letter (e.g. 'T') when associated
// mine — true when owned by this controller (drives white vs green)
//
// "Unassociated" here always meant "unowned" — this also reflects a real
// transponder-based association check (only for srsCapable units; unchanged
// for everything else).
export function computeStarsSymbolMap(visibleUnits, ownership, displayFdb, myControllerId, associated) {
  const map = {}
  for (const [id, unit] of Object.entries(visibleUnits)) {
    const owner = ownership[String(id)]
    const assoc = !unit?.srsCapable || !!associated[String(id)]
    // Treat as "mine" if owned by me, or if I have a sticky FDB (post-handoff sender)
    const mine  = owner === myControllerId || !!displayFdb[String(id)]
    // 2-char ID in either order (e.g. "1A" or "A1") — extract the letter
    const m   = (assoc && owner?.length === 2) ? owner.match(/[A-Z]/) : null
    const isVfrCode = unit?.srsCapable && !assoc && Number(unit.transponder?.mode3) === 1200
    const sym = m ? m[0] : isVfrCode ? 'V' : '*'
    map[id] = { sym, mine }
  }
  return map
}

// Altitude filter (MULTI FUNC F / FC) — suppresses tracks whose altitude
// falls outside the filter range for their association status (symbolMap
// sym === '*' means unassociated). Units with no altitude data (elevation
// unavailable) are never filtered. Beacon readout forces beacon tracks
// through regardless.
export function computeStarsFilteredUnits(visibleUnits, symbolMap, beaconReadout, altFilter) {
  const { loU, hiU, loA, hiA } = altFilter
  const out = {}
  for (const [id, unit] of Object.entries(visibleUnits)) {
    const alt = unit.position?.alt
    if (alt == null) { out[id] = unit; continue }
    const hundreds   = (alt * METERS_TO_FEET) / 100
    const sym        = symbolMap[id]?.sym
    const associated = sym !== '*' && sym !== 'V'
    const [lo, hi]   = associated ? [loA, hiA] : [loU, hiU]
    if (hundreds >= lo && hundreds <= hi) { out[id] = unit; continue }
    if (beaconReadout && hasLiveSquawk(unit)) out[id] = unit
  }
  return out
}
