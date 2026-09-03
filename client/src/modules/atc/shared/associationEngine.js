// Transponder-based association — pure logic, no React/store imports, same
// style as stars/stca/formations.js. See
// resources/specs/transponder-correlation-spec.md §3 for the full rule set.
//
// Association is a reveal gate, not a discovery mechanism: TRACS already
// knows the true unit-to-flight-plan link (Olympus ground-truth callsign).
// This only decides when the controller is allowed to see it, by requiring
// the live squawk to match the plan's assigned code too.
//
// Matches purely on live callsign + code — NOT on store/flightPlans.js's
// plan.unitId. That field is only ever populated via the FPE's ctrl-click
// flow; a plan typed directly into StripBay's callsign box (a normal, very
// common way to add a strip) never gets one, and would otherwise be
// permanently unassociatable no matter how well its code/callsign matched.

import { resolveCallsign } from '../../../utils/callsign.js'
import { hasLiveSquawk } from '../../../utils/transponder.js'

// Every AID-entry point (FPE, StripBay's add-strip box) caps at 8 chars, so
// the canonical identifier for any aircraft is always its live callsign
// truncated to exactly this length.
const AID_MAX_LEN = 8

function normalizeCode(code) {
  return String(code ?? '').padStart(4, '0')
}

/**
 * @param {Object} units          live units keyed by id (useUnitsStore().units)
 * @param {Object} flightPlans    plans keyed by AID (useFlightPlansStore().plans)
 * @param {Object} ownership      unitId -> controllerId (useAtcStore().ownership)
 * @param {Object} previousAssociated  prior { [unitId]: aid } (useAssociationStore().associated)
 * @returns {Object} next { [unitId]: aid } — sticky-while-owned, sparse (only associated entries present)
 */
export function computeAssociations({ units, flightPlans, ownership = {}, previousAssociated = {} }) {
  const next = {}
  const plans = Object.values(flightPlans ?? {})

  // Retain existing associations — but stickiness (teardown only on flight-
  // plan removal or the unit dying, §3.4) only applies while the track is
  // owned. Sticky exists to protect an actively-controlled track from
  // flickering on a live code drift (that's what the Line 3 mismatch
  // indicator is for instead — see DatablockOverlay); an unowned track has
  // no controller relationship to protect, so it re-derives fresh below
  // every pass instead of staying pinned to a code it no longer matches.
  for (const [unitId, aid] of Object.entries(previousAssociated)) {
    if (!units[unitId]) continue      // unit dead/despawned
    if (!flightPlans?.[aid]) continue // flight plan removed
    if (!ownership[unitId]) continue  // not owned — don't stick, re-derive below
    next[unitId] = aid
  }

  // Look for newly-qualifying associations — double gate, mirroring CRC's
  // own rule verbatim (code match AND callsign-matches-AID), which closes
  // the duplicate/borrowed-code case: TRACS's callsign side is ground
  // truth, not self-reported, so this is free correctness CRC doesn't have.
  for (const [unitId, unit] of Object.entries(units)) {
    if (next[unitId]) continue // already associated, retained above
    if (!unit?.srsCapable) continue // no real transponder data for this unit
    if (!hasLiveSquawk(unit)) continue // standby, or status normal/ident with no mode3 code set — nothing to match yet
    const squawk = unit.transponder.mode3
    const liveCallsign = resolveCallsign(unit).toUpperCase()

    for (const plan of plans) {
      const planAid = plan.aid?.toUpperCase()
      if (!planAid) continue
      // Must equal the canonical (truncated) form, not just any shorter
      // valid prefix — a partial abbreviation like "DENIMCH" isn't this
      // aircraft's identifier, it's a different, incomplete one. Truncated
      // rather than exact-equals because resolveCallsign() doesn't truncate
      // a long DCS unit/pilot name (e.g. "Denim Chicken" -> "DENIMCHICKEN")
      // itself, and the AID field can't hold more than AID_MAX_LEN anyway.
      if (planAid !== liveCallsign.slice(0, AID_MAX_LEN)) continue
      if (normalizeCode(squawk) !== normalizeCode(plan.bcn)) continue
      next[unitId] = planAid
      break
    }
  }

  return next
}
