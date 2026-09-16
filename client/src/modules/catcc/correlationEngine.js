import { resolveCallsign } from '../../utils/callsign.js'
import { hasLiveSquawk, normalizeCode } from '../../utils/transponder.js'

/**
 * CATCC's own correlation logic — single typed BCN + callsign match, no
 * stickiness. Deliberately separate from STARS' associationEngine.js
 * (sticky-while-owned, AID/bcn/dcsUnitId fallback) and ABM's
 * correlationEngine.js (FRAG roster IFF mode 1-4, no stickiness) — same
 * extraction pattern, not shared logic; the three domains have genuine
 * matching-rule differences.
 *
 * Not srsCapable (no relay, or a unit that's never reported real SRS
 * transponder data) → old model, unchanged: side number shown as soon as
 * it's typed/matched, no gating.
 *
 * srsCapable → gated like STARS' LDB/FDB (see
 * resources/specs/transponder-correlation-spec.md): no live squawk yet →
 * nothing shown (CatccScope falls back to 'XXX'); live squawk but no BCN
 * match → the live code itself shows instead (pendingCodes, reduced info
 * rather than full anonymity); BCN AND callsign both match (double-gate,
 * same rationale as associationEngine.js — callsign is ground truth, not
 * self-reported, so requiring both closes the duplicate/borrowed-code case
 * for free) → reveal the side number.
 */
export function computeCatccCorrelations({ entries, visibleUnits }) {
  const correlations = {}
  const pendingCodes = {}
  for (const entry of entries) {
    let uid = entry.unitId
    if (uid && !visibleUnits[uid]) uid = null  // stale — unit was deleted and recreated
    if (!uid && entry.callsign) {
      for (const [id, unit] of Object.entries(visibleUnits)) {
        if (resolveCallsign(unit) === entry.callsign) { uid = id; break }
      }
    }
    if (!uid) continue
    const unit = visibleUnits[uid]

    if (!unit?.srsCapable) {
      if (entry.sideNumber) correlations[String(uid)] = entry.sideNumber
      continue
    }

    if (!hasLiveSquawk(unit)) continue // nothing to gate on yet

    const squawkMatches   = normalizeCode(unit.transponder.mode3) === normalizeCode(entry.bcn)
    const callsignMatches = resolveCallsign(unit) === entry.callsign
    if (entry.sideNumber && squawkMatches && callsignMatches) {
      correlations[String(uid)] = entry.sideNumber
    } else {
      pendingCodes[String(uid)] = normalizeCode(unit.transponder.mode3)
    }
  }
  return { correlations, pendingCodes }
}
