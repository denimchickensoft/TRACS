// Simulated squawk-standby wingmen ("primary-only" tracks).
//
// TRACS has no transponder/beacon simulation — every DCS aircraft currently
// behaves as if squawking Mode C, including tight-formation wingmen, which
// would false-alarm STCA constantly. This groups live units by their DCS
// group (unit.groupID, decoded server-side in server/src/decoder.js and
// passed through untouched by store/units.js) and picks a flight lead per
// group, so callers can render/exempt the rest as primary-only.
//
// Lead detection: DCS's own AI-flight naming convention concatenates
// "<callsign> <flight>-<element>" (stripped of the space/dash by
// resolveCallsign()'s stripAcid, e.g. "ENFIELD11"/"ENFIELD12" for flight 1
// elements 1/2 — the same convention utils/callsign.js's matchLiveByPrefix
// already relies on). Within one groupID every member shares the same
// flight-number prefix, so the trailing digit alone orders elements —
// lowest digit wins. Falls back to lowest unitID (DCS's own creation-order
// id — group member #1 is created first) when digits aren't parseable.
//
// Manual designations (.WNG + click lead + click wingman, see StarsScope.jsx's
// WNG_P2 handling) cover aircraft that don't share a DCS group at all (e.g.
// a human wingman flying alongside an AI lead from an unrelated group) — a
// case the groupID grouping above can never catch on its own. They're
// unioned in on top of the automatic detection below.

import { resolveCallsign } from '../../../../utils/callsign.js'
import { hasLiveSquawk }  from '../../../../utils/transponder.js'

/**
 * @param {Object} units      live units keyed by id (useUnitsStore().units)
 * @param {Object} ownership  unitId → controllerId (useAtcStore().ownership)
 * @param {string[]} [manualWingmenIds]  windowSettings.manualWingmen — explicit overrides
 * @returns {Set<string>} ids of units that should render as primary-only wingmen
 */
export function computeWingmanIds(units, ownership, manualWingmenIds = []) {
  const groups = new Map() // groupID -> [{id, unit}]
  for (const [id, unit] of Object.entries(units)) {
    if (unit.groupID == null) continue
    if (!groups.has(unit.groupID)) groups.set(unit.groupID, [])
    groups.get(unit.groupID).push({ id, unit })
  }

  const wingmen = new Set()
  for (const members of groups.values()) {
    if (members.length < 2) continue

    const withDigits = members.map((m) => {
      const match = resolveCallsign(m.unit).match(/(\d)$/)
      return { ...m, digit: match ? parseInt(match[1], 10) : null }
    })

    const lead = withDigits.every((m) => m.digit != null)
      ? withDigits.reduce((a, b) => (b.digit < a.digit ? b : a))
      : members.reduce((a, b) => ((b.unit.unitID ?? Infinity) < (a.unit.unitID ?? Infinity) ? b : a))

    for (const m of members) {
      if (m.id === lead.id) continue
      if (ownership[m.id] !== undefined) continue // controller-claimed — never primary-only
      wingmen.add(m.id)
    }
  }

  for (const id of manualWingmenIds) {
    if (!(id in units)) continue
    if (ownership[id] !== undefined) continue // controller-claimed — never primary-only
    wingmen.add(id)
  }

  return wingmen
}

/**
 * Blends the groupID-based guess above with real transponder data: once a
 * unit has
 * ever reported real SRS transponder data (unit.srsCapable), its real
 * status supersedes the guess — the guess remains the only signal for any
 * unit that isn't srsCapable (AI, non-SRS humans), unchanged. Unlike the
 * opt-in guess, real standby is ground truth and is not gated behind the
 * .WNG preference.
 *
 * @returns {Set<string>} ids that should render as primary-only (no datablock)
 */
export function resolvePrimaryOnlyIds(units, ownership, manualWingmenIds, guessEnabled) {
  const guessed = guessEnabled ? computeWingmanIds(units, ownership, manualWingmenIds) : null
  const result = new Set()
  for (const [id, unit] of Object.entries(units)) {
    if (unit.srsCapable) {
      // Also covers status normal/ident with no mode3 code set (e.g.
      // military mode4-only) — no code to correlate, same as true standby.
      if (!hasLiveSquawk(unit)) result.add(id)
      continue
    }
    if (guessed?.has(id)) result.add(id)
  }
  return result
}
