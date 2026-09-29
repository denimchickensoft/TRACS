import { useAtcStore }     from '../store/atc'
import { useSessionStore } from '../store/session'
import { callsignFromDcsName, parseUnitName, stripAcid } from './callsignShape.js'

// stripAcid is exported for manually-added ATO flights (Ato.jsx/Frag.jsx),
// which have no DCS unitId to match against a live Olympus unit — they
// instead search for a live unit whose resolveCallsign() output matches the
// entered callsign after the same normalization.
export { stripAcid }

// Longest aircraft ID (AID) any entry point accepts, and the length every
// AID key is truncated to. 13 fits the longest stock DCS callsign word plus
// flight and element digits (Springfield 1-1 -> SPRINGFIELD11).
export const AID_MAX_LEN = 13

export { parseUnitName }

/**
 * Resolve the base AID from Olympus data, ignoring any controller override.
 * Used when reverting a rename back to the original name.
 */
export function resolveOriginalCallsign(unit) {
  if (unit.customString) return stripAcid(unit.customString)
  if (useSessionStore.getState().useDcsNames) return callsignFromDcsName(unit)
  return stripAcid(unit.callsign || unit.unitName || String(unit.id))
}

/**
 * Resolve the AID (Aircraft ID) shown in datablocks.
 *
 * Priority:
 *   1. Controller-assigned callsign override
 *   2. unit.customString — real-world callsign pushed in by an external
 *      tool (e.g. LogiSync mirroring VATSIM/ADS-B traffic; see that
 *      project's architecture.md §A.3b). Not DCS mission data, so it takes
 *      priority over useDcsNames' own source fields below rather than being
 *      gated by that toggle.
 *   3. If useDcsNames ON: the callsign found in unit.unitName by its shape
 *      (see utils/callsignShape.js), with the fallbacks in callsignFromDcsName
 *   4. If useDcsNames OFF: unit.callsign (mission editor name)
 *   5. Unit ID as last resort
 */
export function resolveCallsign(unit) {
  const override = useAtcStore.getState().callsignOverrides[String(unit.id)]
  if (override) return stripAcid(override)

  if (unit.customString) return stripAcid(unit.customString)

  if (useSessionStore.getState().useDcsNames) return callsignFromDcsName(unit)

  return stripAcid(unit.callsign || unit.unitName || String(unit.id))
}

/**
 * Whether the current session's live unit IDs can be trusted to match the
 * mission file's per-unit `unitId` (i.e. `dcsUnitId` on an imported flight
 * plan). True only for a direct Olympus connection: Olympus's `unitID`
 * reliably mirrors DCS's real internal ID. Tacview's live unit IDs do NOT
 * (its own internal enumeration counter, unrelated to DCS's engine state --
 * see buildLiveUnitLookup()'s comment below, an existing, un-gated exposure
 * to this same risk in ABM/AIC correlation). Under Tacview, matching on this
 * ID isn't just unhelpful, it risks a false-positive collision with an
 * unrelated plan's `dcsUnitId`, so this is excluded there -- and for
 * `relay`, since what backs a relay session isn't guaranteed to be Olympus.
 */
export function dcsUnitIdReliable() {
  return useSessionStore.getState().sourceType === 'olympus'
}

/**
 * Finds the AID of a flight plan already filed for this unit. Three tiers,
 * most to least reliable:
 *
 *   1. DCS's own internal unit ID (only when dcsUnitIdReliable(), see
 *      above): Olympus's live `unitID` field reliably matches the mission
 *      file's per-unit `unitId`. A .miz-imported flight plan carries this
 *      as `dcsUnitId` (see mizFlightPlans.js). This is the ONLY tier that
 *      can rescue a single-ship AI group: confirmed against a real live
 *      payload that Olympus's `unitName` AND `callsign` both just report
 *      the bare unit name ("Texaco 2") for a solo group -- the mission
 *      file's true callsign ("Texaco21") simply never reaches live
 *      telemetry as a string at all, so no string-based tier could ever
 *      find it.
 *   2. resolveCallsign(unit) (today's behavior, unchanged) -- the common
 *      case: multi-ship groups (unitName already carries a "-N" element
 *      suffix) and piped multiplayer names ("Colt 1-1 | Denim" -> "COLT11")
 *      both already match on their own.
 *   3. stripAcid(unit.callsign), kept as a harmless last resort in case
 *      some other data source or unit type ever does expose a distinct
 *      callsign field (confirmed NOT to for the AI case above, but not
 *      disproven universally).
 *
 * Strictly additive at every tier: never overrides an already-matching
 * earlier tier, so it can't affect a case that already works.
 */
export function findFlightPlanAid(unit, plans) {
  if (unit.unitID != null && dcsUnitIdReliable()) {
    const byDcsId = Object.values(plans).find(
      (p) => p.dcsUnitId != null && String(p.dcsUnitId) === String(unit.unitID)
    )
    if (byDcsId) return byDcsId.aid
  }
  // Truncated to AID_MAX_LEN so a long live callsign resolves to the same
  // key the FPE/Strip Bay would have filed it under.
  const primary = resolveCallsign(unit)?.toUpperCase().slice(0, AID_MAX_LEN)
  if (primary && plans[primary]) return primary
  const fallback = stripAcid(unit.callsign ?? '').slice(0, AID_MAX_LEN)
  if (fallback && plans[fallback]) return fallback
  return primary ?? fallback ?? null
}

/**
 * Manually-added ATO flights (AddAtoFlight.jsx) have no DCS unitId, and no
 * reliable way to predict the *exact* per-element callsign DCS will assign —
 * flight number + element digit are concatenated with no separator (flight
 * 1's elements resolve as "SHELL11"/"SHELL12", flight 3's as "SHELL31"/
 * "SHELL32"). Prefix matching sidesteps needing to guess the element digit:
 * every live unit whose resolved callsign starts with the controller-
 * entered prefix counts as a match. The prefix must still include the
 * flight number ("SHELL1", not bare "SHELL") — otherwise it also sweeps in
 * any other flight sharing the same NATO callsign name (e.g. a separate
 * "Shell 3" elsewhere in the mission). Returns { key, unit, callsign }[],
 * sorted by callsign for stable display order.
 */
/**
 * Normalizes a callsign into a token safe for use as a popup window `name`
 * (and, identically, as an ABM focus-window's displayStore windowId) — see
 * modules/abm/AbmFocusWindow.jsx / modules/abm/actions/index.js's
 * popOutAbmFocusPanel. Both derive the token this same way so popping the
 * same callsign out twice reuses window.open()'s same-name-reuses-the-window
 * behavior instead of spawning a duplicate popup.
 */
export function sanitizeFocusToken(callsign) {
  return (callsign ?? '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_')
}

// ABM focus panels are keyed by the callsign they follow, except another
// side's aircraft, which is followed by unit ID so its panel never shows the
// callsign. '#' can't appear in a callsign key (stripAcid), so the two never
// collide.
const UNIT_FOCUS_PREFIX = '#'

export function unitFocusKey(unitId) {
  return `${UNIT_FOCUS_PREFIX}${unitId}`
}

// The name shown in a focus panel's title bar.
export function focusTitle(key) {
  return key.startsWith(UNIT_FOCUS_PREFIX) ? 'CONTACT' : key
}

// The live unit a focus panel follows, or null.
export function findFocusedUnit(key, liveUnits) {
  if (key.startsWith(UNIT_FOCUS_PREFIX)) return liveUnits?.[key.slice(UNIT_FOCUS_PREFIX.length)] ?? null
  return matchLiveByPrefix(key, liveUnits).find((m) => m.callsign === key)?.unit ?? null
}

export function matchLiveByPrefix(prefix, liveUnits) {
  const norm = stripAcid(prefix ?? '')
  if (!norm) return []
  const out = []
  for (const [key, unit] of Object.entries(liveUnits ?? {})) {
    const callsign = resolveCallsign(unit)
    if (callsign && callsign.startsWith(norm)) out.push({ key, unit, callsign })
  }
  out.sort((a, b) => a.callsign.localeCompare(b.callsign))
  return out
}

/**
 * Correlates parsed mission-file units (parseMission.js's per-unit `unitId`/
 * `callsign`) to their live track. Two-tier, in priority order:
 *
 *   1. Numeric unitId match (unit.unitID === missionUnit.unitId) — Olympus
 *      reports DCS's real internal unit ID directly, so this is an exact,
 *      reliable match.
 *   2. Normalized-callsign text match — Tacview's live unitID has NO
 *      relationship to the mission file's unitId for statically-placed (AI)
 *      units: confirmed against a real mission (Colt 2-1/2-2/1-1/
 *      1-2's Tacview object IDs incremented by an exact constant step
 *      regardless of the real, irregularly-spaced DCS unitId gaps — Tacview
 *      assigns IDs from its own internal enumeration counter, unrelated to
 *      DCS's engine state, for any unit that wasn't dynamically created at
 *      runtime). tacviewCore.js's unitId = objectId + 0xFFFFFF formula only
 *      holds for dynamically-created player slots, not AI-authored units.
 *      What DOES carry over reliably: the mission file's per-unit
 *      `callsign.name` (e.g. "Colt21") and Tacview's `Pilot` (e.g.
 *      "Colt 2-1") both normalize to the same string via the existing
 *      stripAcid()/resolveCallsign() pipeline, since both reflect the same
 *      DCS-authored naming convention through different fields.
 *
 * Building one lookup via buildLiveUnitLookup() and reusing it across many
 * mission units (rather than calling this per-unit in a loop) avoids an
 * O(n*m) rescan — see that function.
 *
 * @returns {{ key: string, unit: object } | null}
 */
export function buildLiveUnitLookup(liveUnits) {
  const byDcsId    = new Map()
  const byCallsign = new Map()
  for (const [key, unit] of Object.entries(liveUnits ?? {})) {
    if (unit.unitID != null) byDcsId.set(unit.unitID, { key, unit })
    const cs = resolveCallsign(unit)
    if (cs) byCallsign.set(cs, { key, unit })
  }
  return (missionUnit) => {
    if (missionUnit?.unitId != null) {
      const hit = byDcsId.get(missionUnit.unitId)
      if (hit) return hit
    }
    const norm = stripAcid(missionUnit?.callsign ?? '')
    return norm ? (byCallsign.get(norm) ?? null) : null
  }
}
