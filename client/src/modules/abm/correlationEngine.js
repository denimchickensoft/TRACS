// ABM transponder correlation — pure logic, no React/store imports, same
// style as atc/shared/associationEngine.js and CATCC's own correlation-sync
// effect. Binds a live SRS-fielded unit to a specific FRAG-assigned aircraft
// (a `flight.units[]` roster row carrying an `iff: {mode1,mode2,mode3}`
// sub-object), revealing its real callsign in place of the cycling
// Mode 1/2/3/4 readout on the datablock.
//
// Correlation is a continuous reveal gate, not a discovery mechanism — same
// principle as STARS' association/CATCC's correlation. Recomputed fresh
// every pass; no stickiness, since ABM has no per-track ownership concept to
// protect the way STARS' sticky-while-owned association does.
//
// Double gate: (any of Mode 1/2/3 exact code match, OR live Mode 4 === true)
// AND live callsign matches the roster row's callsign. Mode 1/2/3 codes are
// assigned per-aircraft and genuinely narrow the candidate search on their
// own; Mode 4 is a bare on/off boolean that can't distinguish between
// candidates by itself, so for a mode4-only match the callsign match isn't
// just a safety net, it's what actually identifies the aircraft.

import { resolveCallsign, stripAcid } from '../../utils/callsign.js'
import { getFlightLinks } from '../../utils/flightLinks.js'
import { normalizeCode } from '../../utils/transponder.js'

function hasLiveCode(unit, field) {
  const t = unit?.transponder
  if (!t) return false
  if (t.status !== 1 && t.status !== 2) return false
  const v = t[field]
  return typeof v === 'number' && v >= 0
}

function codeMatches(unit, field, assignedCode) {
  if (!assignedCode) return false
  if (!hasLiveCode(unit, field)) return false
  return normalizeCode(unit.transponder[field]) === normalizeCode(assignedCode)
}

/**
 * @param {Object} units    live units keyed by id (useUnitsStore().units)
 * @param {Array}  flights  useAbmMissionStore().flights — imported flights
 *   carry their real per-aircraft roster on `units: [{ unitName, iff:
 *   {mode1,mode2,mode3} }]`; manual flights carry the equivalent on a
 *   separate `iffRoster` field instead (their own `units` is an unrelated
 *   placeholder-count array for Ato.jsx's NUM/TYPE column — see
 *   store/abmMission.js's setUnitIff comment for why the two can't share a
 *   field)
 * @returns {Object} { [unitId]: { callsign, flightName, flightId } } — sparse,
 *   only correlated entries present
 */
export function computeCorrelations({ units, flights }) {
  const result = {}
  const links = getFlightLinks(flights ?? [], units ?? {})

  const manualRows = []
  for (const flight of flights ?? []) {
    if (!flight.manual) continue
    for (const row of flight.iffRoster ?? []) {
      if (row.callsign) manualRows.push({ callsign: row.callsign, iff: row.iff, flightName: flight.name, flightId: flight.flightId })
    }
  }

  const byId = new Map((flights ?? []).map((f) => [f.flightId, f]))

  for (const [unitId, unit] of Object.entries(units ?? {})) {
    if (!unit?.srsCapable) continue

    // An imported aircraft's roster row is the mission unit it links to
    // (utils/flightLinks.js); a manual row matches the live callsign (rows
    // are stored pre-normalized, see AbmScope.jsx's Ctrl+Shift+Click).
    let row = null
    const slot = links.flightOf(unitId)
    const flight = slot && byId.get(slot.flightId)
    if (flight) {
      const u = flight.units?.[slot.unitIndex]
      if (u) row = { callsign: u.unitName, iff: u.iff, flightName: flight.name, flightId: flight.flightId }
    } else {
      const liveCallsign = resolveCallsign(unit)
      if (liveCallsign) row = manualRows.find((r) => stripAcid(r.callsign ?? '') === liveCallsign) ?? null
    }
    if (!row) continue

    const iff = row.iff ?? {}
    const anyModeMatches =
      codeMatches(unit, 'mode1', iff.mode1) ||
      codeMatches(unit, 'mode2', iff.mode2) ||
      codeMatches(unit, 'mode3', iff.mode3) ||
      unit.transponder?.mode4 === true
    if (anyModeMatches) result[String(unitId)] = { callsign: row.callsign, flightName: row.flightName, flightId: row.flightId }
  }

  return result
}
