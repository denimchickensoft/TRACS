// Transponder-based association — pure logic, no React/store imports, same
// style as stars/stca/formations.js.
//
// Association is a reveal gate, not a discovery mechanism: TRACS already
// knows the true unit-to-flight-plan link (Olympus ground-truth callsign).
// This only decides when the controller is allowed to see it, by requiring
// the live squawk to match the plan's assigned code too.
//
// Candidates, most to least specific, each still needing the squawk to
// match the plan's code: the plan filed under the live callsign; a plan the
// controller tied to this contact (FPE save after a Ctrl+Click, `plan.unitId`);
// the mission plan by DCS unit ID; and the mission plan the contact is
// linked to (utils/planLinks.js). An exact link offers only its own plan; a
// guessed one (a player on the exporter client or Tacview, placed by the
// digit of their MP callsign) offers every plan of the contact's own DCS
// group, so the squawk picks the slot. A squawk never reaches a plan outside
// the contact's group that way.
//
// With no transponder data for a unit (no SRS relay), there is no squawk:
// it associates on identity alone, a guessed link with its guessed slot.
//
// A plan associates with one contact at a time: one held by an owned track
// isn't taken over, and two new contacts squawking the same plan's code get
// neither until only one does.
//
// The DCS unit ID tier tries a plan's `dcsUnitId` (set by .miz import)
// against the live unit's `unitID`. It still matters for plans filed before
// they carried their mission slot: it is how a single-ship AI group
// associates, whose live callsign never carries the mission
// file's true disambiguating digit (see utils/callsign.js findFlightPlanAid
// for the full story). Gated by the caller-supplied `dcsUnitIdReliable` flag
// rather than reading it here, to keep this module free of store imports
// (same "pure logic" convention as stars/stca/formations.js) — see
// utils/callsign.js's dcsUnitIdReliable() for why this must never run
// against Tacview-sourced unit IDs (a real false-positive-match risk, not
// just an ineffective no-op).

import { resolveCallsign, resolveOriginalCallsign, AID_MAX_LEN } from '../../../utils/callsign.js'
import { hasLiveSquawk, normalizeCode } from '../../../utils/transponder.js'

// Every AID-entry point (FPE, StripBay's add-strip box, imports) caps at
// AID_MAX_LEN, so the canonical identifier for any aircraft is always its
// live callsign truncated to exactly that length.

/**
 * @param {Object} units          live units keyed by id (useUnitsStore().units)
 * @param {Object} flightPlans    plans keyed by AID (useFlightPlansStore().plans)
 * @param {Object} ownership      unitId -> controllerId (useAtcStore().ownership)
 * @param {Object} previousAssociated  prior { [unitId]: aid } (useAssociationStore().associated)
 * @param {boolean} dcsUnitIdReliable  whether live unit IDs can be trusted against plan.dcsUnitId
 *   this session (utils/callsign.js's dcsUnitIdReliable() — true only for a direct Olympus
 *   connection). Passed in rather than read here to keep this module store-free.
 * @param {Function} planLink     unitId -> { aid, exact, groupAids } | null (utils/planLinks.js)
 * @returns {Object} next { [unitId]: aid } — sticky-while-owned, sparse (only associated entries present)
 */
export function computeAssociations({ units, flightPlans, ownership = {}, previousAssociated = {}, dcsUnitIdReliable = false, planLink = () => null }) {
  const next = {}
  const plans = Object.values(flightPlans ?? {})
  const taken = new Set()

  // Retain existing associations — but stickiness (teardown only on flight-
  // plan removal or the unit dying) only applies while the track is
  // owned. Sticky exists to protect an actively-controlled track from
  // flickering on a live code drift (that's what the Line 3 mismatch
  // indicator is for instead — see DatablockOverlay); an unowned track has
  // no controller relationship to protect, so it re-derives fresh below
  // every pass instead of staying pinned to a code it no longer matches.
  for (const [unitId, aid] of Object.entries(previousAssociated)) {
    if (!units[unitId]) continue      // unit dead/despawned
    if (!flightPlans?.[aid]) continue // flight plan removed
    if (!ownership[unitId]) continue  // not owned — don't stick, re-derive below
    if (taken.has(aid)) continue
    next[unitId] = aid
    taken.add(aid)
  }

  // Look for newly-qualifying associations — double gate, mirroring CRC's
  // own rule (code match AND the plan is this aircraft's), which closes
  // the duplicate/borrowed-code case: TRACS's identity side is ground
  // truth, not self-reported, so this is free correctness CRC doesn't have.
  const claims = new Map() // aid -> [unitId]
  for (const [unitId, unit] of Object.entries(units)) {
    if (next[unitId]) continue // already associated, retained above
    // A unit with no transponder data (no SRS relay) has no squawk to
    // confirm anything, so it associates on identity alone; one with
    // transponder data needs its code to match.
    const transponder = !!unit?.srsCapable
    if (transponder && !hasLiveSquawk(unit)) continue // standby, or status normal/ident with no mode3 code set — nothing to match yet
    const code = transponder ? normalizeCode(unit.transponder.mode3) : null

    const candidates = []
    // Must equal the canonical (truncated) form, not just any shorter
    // valid prefix — a partial abbreviation like "DENIMCH" isn't this
    // aircraft's identifier, it's a different, incomplete one. Truncated
    // rather than exact-equals because resolveCallsign() doesn't truncate
    // a long DCS unit/pilot name (e.g. "Denim Chicken" -> "DENIMCHICKEN")
    // itself, and the AID field can't hold more than AID_MAX_LEN anyway.
    // Both the shown callsign and the one under any .rename: a rename only
    // changes what is displayed, never which plan is the aircraft's.
    for (const name of [resolveCallsign(unit), resolveOriginalCallsign(unit)]) {
      const cs = name?.toUpperCase().slice(0, AID_MAX_LEN)
      if (cs && flightPlans?.[cs] && !candidates.includes(cs)) candidates.push(cs)
    }
    for (const p of plans) {
      if (p.unitId != null && String(p.unitId) === unitId) candidates.push(p.aid)
    }
    if (dcsUnitIdReliable && unit.unitID != null) {
      const byId = plans.find((p) => p.dcsUnitId != null && String(p.dcsUnitId) === String(unit.unitID))
      if (byId) candidates.push(byId.aid)
    }
    // A guessed link offers its whole group to a squawk, which picks the
    // slot; with no squawk, only the guessed slot itself.
    const link = planLink(unitId)
    if (link) candidates.push(...(link.exact || !transponder ? [link.aid] : link.groupAids))

    const aid = candidates.find((a) =>
      !taken.has(a) && flightPlans[a] && (!transponder || normalizeCode(flightPlans[a].bcn) === code))
    if (!aid) continue
    if (!claims.has(aid)) claims.set(aid, [])
    claims.get(aid).push(unitId)
  }

  for (const [aid, claimants] of claims) {
    if (claimants.length === 1) next[claimants[0]] = aid
  }

  return next
}
