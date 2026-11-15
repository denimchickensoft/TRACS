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
  // Can resolve to '' for a name with no A-Z or 0-9; see resolveCallsign.
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

  // The fallback picks the first non-empty field before stripping, so a
  // name stripAcid empties out entirely (no A-Z or 0-9, e.g. a Cyrillic
  // pilot name) resolves to '' here instead of reaching the unit ID. Under
  // Tacview, which never sends `callsign`, that applies to every such name.
  return stripAcid(unit.callsign || unit.unitName || String(unit.id))
}

/**
 * Whether the current session's live unit IDs can be trusted to match the
 * mission file's per-unit `unitId` (i.e. `dcsUnitId` on an imported flight
 * plan). True for a direct Olympus connection and for TRACS's own DCS
 * exporter (relay-hosted): both report DCS's real internal unit ID. (A
 * client-side exporter hook only sees runtime object IDs; its units carry
 * no `unitID` at all, see server/src/exporterRelayClient.js.)
 * Tacview's live unit IDs do NOT (its own internal enumeration counter,
 * unrelated to DCS's engine state). Under Tacview, direct or relay-hosted, matching on this ID
 * isn't just unhelpful, it risks a false-positive collision with an
 * unrelated plan's `dcsUnitId`, so this is excluded there. A relay session
 * starts as 'tacview' until the server's status says which source the relay
 * actually serves.
 */
export function dcsUnitIdReliable() {
  const { sourceType } = useSessionStore.getState()
  return sourceType === 'olympus' || sourceType === 'exporter'
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
 * Normalizes a focus key (callsign, unit or location) into a token safe for
 * use as a popup window `name` (and, identically, as an ABM focus-window's
 * displayStore windowId) — see modules/abm/AbmFocusWindow.jsx /
 * modules/abm/actions/index.js's popOutAbmFocusPanel. Both derive the token
 * this same way so popping the same key out twice reuses window.open()'s
 * same-name-reuses-the-window behavior instead of spawning a duplicate popup.
 */
export function sanitizeFocusToken(key) {
  return (key ?? '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_')
}

// ABM focus panels are keyed by the callsign they follow, except another
// side's aircraft, which is followed by unit ID so its panel never shows the
// callsign. '#' can't appear in a callsign key (stripAcid), so the two never
// collide.
const UNIT_FOCUS_PREFIX = '#'

export function unitFocusKey(unitId) {
  return `${UNIT_FOCUS_PREFIX}${unitId}`
}

// A focus panel can also sit on a fixed place instead of a unit: '@<ICAO>'
// for an airfield, '@<lat>,<lng>' for any other map point. '@' can't appear
// in a callsign key either. Points are rounded to 3 decimals (~100m) so
// double-clicking the same spot again reuses the panel already open there.
const LOCATION_FOCUS_PREFIX = '@'

export function airfieldFocusKey(icao) {
  return `${LOCATION_FOCUS_PREFIX}${icao}`
}

export function pointFocusKey(lat, lng) {
  return `${LOCATION_FOCUS_PREFIX}${lat.toFixed(3)},${lng.toFixed(3)}`
}

export function isLocationFocusKey(key) {
  return key.startsWith(LOCATION_FOCUS_PREFIX)
}

// The name shown in a focus panel's title bar.
export function focusTitle(key) {
  if (key.startsWith(UNIT_FOCUS_PREFIX)) return 'CONTACT'
  if (isLocationFocusKey(key)) return key.slice(LOCATION_FOCUS_PREFIX.length).replace(',', ' ')
  return key
}

// The live unit a focus panel follows, or null (always null for a location).
export function findFocusedUnit(key, liveUnits) {
  if (isLocationFocusKey(key)) return null
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
