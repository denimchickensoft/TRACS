import { hasLiveSquawk } from '../../../utils/transponder.js'
import { M_TO_FT as METERS_TO_FEET } from '../../../utils/units.js'
import { findFlightPlanAid } from '../../../utils/callsign.js'


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

// The flight plan for a displayed track (by unit id string): the plan the
// track's callsign resolves to, else a plan explicitly bound to that unit.
export function findPlanForUid(uid, allUnits, plans) {
  const unit = Object.values(allUnits).find(u => String(u.id) === uid)
  const aid  = unit ? findFlightPlanAid(unit, plans) : null
  return (aid ? plans[aid] : null)
      ?? Object.values(plans).find(p => String(p.unitId) === uid)
}

// Render-time display values derived from the STARS window settings, with
// profile defaults where a setting is unset.
export function deriveDisplaySettings(windowSettings, activeProfile) {
  // Background brightness: 0 = black, 100 = medium gray (~#A0A0A0)
  const bkgGray = Math.round((windowSettings.briteBkg ?? 0) / 100 * 160)
  const bgColor = `rgb(${bkgGray},${bkgGray},${bkgGray})`

  // ldrLength stored as 0–7; convert to pixels (10px per unit). null → profile default.
  const ldrLength = windowSettings.ldrLength != null
    ? windowSettings.ldrLength * 10
    : activeProfile.visual.dataBlock?.leaderLength ?? 40
  // ldrAngleDeg stored as canvas degrees (0=right, CW). null → profile default.
  const ldrAngleDeg = windowSettings.ldrAngleDeg ?? activeProfile.visual.dataBlock?.leaderAngleDeg ?? -45

  return {
    bgColor, ldrLength, ldrAngleDeg,
    // Datablock and DCB brightness (0–1 opacity)
    briteFdb: (windowSettings.briteFdb ?? 80) / 100,
    briteLdb: (windowSettings.briteLdb ?? 70) / 100,
    briteDcb: (windowSettings.briteDcb ?? 80) / 100,
    // Character size (0–5 scale; 3 = default)
    csDatablocks:  windowSettings.csDatablocks ?? 3,
    csDcb:         windowSettings.csDcb        ?? 3,
    dcbPos:        windowSettings.dcbPosition ?? 'top',
    coordsVisible: windowSettings.coordsVisible ?? false,
  }
}
