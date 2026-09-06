import { useAtcStore }     from '../store/atc'
import { useSessionStore } from '../store/session'

// Exported for manually-added ATO flights (Ato.jsx/Frag.jsx), which have no
// DCS unitId to match against a live Olympus unit — they instead search for
// a live unit whose resolveCallsign() output matches the entered callsign
// after the same normalization.
export function stripAcid(s) {
  return s.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

// Split "VIPER1 | John Smith" → { acid: 'VIPER1', pilotName: 'John Smith' }
// No pipe → { acid: stripped unitName, pilotName: null }
export function parseUnitName(unitName) {
  if (!unitName) return { acid: '', pilotName: null }
  const pipeIdx = unitName.indexOf('|')
  if (pipeIdx === -1) return { acid: stripAcid(unitName), pilotName: null }
  return {
    acid:      stripAcid(unitName.slice(0, pipeIdx).trim()),
    pilotName: unitName.slice(pipeIdx + 1).trim() || null,
  }
}

/**
 * Resolve the base AID from Olympus data, ignoring any controller override.
 * Used when reverting a rename back to the original name.
 */
export function resolveOriginalCallsign(unit) {
  if (unit.customString) return stripAcid(unit.customString)

  if (useSessionStore.getState().useDcsNames) {
    const { acid } = parseUnitName(unit.unitName)
    return acid || stripAcid(unit.callsign || String(unit.id))
  }
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
 *   3. If useDcsNames ON: unit.unitName (pipe-split left side if '|' present)
 *   4. If useDcsNames OFF: unit.callsign (mission editor name)
 *   5. Unit ID as last resort
 */
export function resolveCallsign(unit) {
  const override = useAtcStore.getState().callsignOverrides[String(unit.id)]
  if (override) return stripAcid(override)

  if (unit.customString) return stripAcid(unit.customString)

  if (useSessionStore.getState().useDcsNames) {
    const { acid } = parseUnitName(unit.unitName)
    return acid || stripAcid(unit.callsign || String(unit.id))
  }

  return stripAcid(unit.callsign || unit.unitName || String(unit.id))
}

/**
 * Resolve the pilot's real name from the pipe convention ("VIPER1 | John Smith").
 * Returns null if useDcsNames is off, no pipe is present, or no unitName exists.
 */
export function resolvePilotName(unit) {
  if (!useSessionStore.getState().useDcsNames) return null
  return parseUnitName(unit.unitName).pilotName
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
 *      units: confirmed 2026-09-06 against a real mission (Colt 2-1/2-2/1-1/
 *      1-2's Tacview object IDs incremented by an exact constant step
 *      regardless of the real, irregularly-spaced DCS unitId gaps — Tacview
 *      assigns IDs from its own internal enumeration counter, unrelated to
 *      DCS's engine state, for any unit that wasn't dynamically created at
 *      runtime). The formula in custom-datasource-tacview-spec.md §4.1 only
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
