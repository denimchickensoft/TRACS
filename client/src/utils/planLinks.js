// Links live units to mission flight plans: the plans filed from the mission
// file (utils/mizFlightPlans.js) carry the slot they were filed for
// (`plan.mission`), so the plans of one DCS group rebuild that group's
// flights and buildFlightLinks (utils/flightLinks.js, the ATO's linking)
// runs over them unchanged.
//
// A link is exact when the unit was matched by its DCS unit ID or unit name
// (Olympus, the exporter host, and AI on every source), and a guess when a
// player was placed by the element digit of their MP callsign (the exporter
// client and Tacview report no unit name for a player). A guessed contact may
// sit in any slot of its group, so association (associationEngine.js) lets
// its squawk pick among the group's plans; an exact one only ever gets its
// own plan.

import { buildFlightLinks } from './flightLinks.js'
import { dcsUnitIdReliable } from './callsign.js'
import { useSessionStore } from '../store/session.js'

function groupKeyOf(m) {
  return m.dcsGroupId != null ? `id:${m.dcsGroupId}` : `name:${m.coalition}:${m.dcsGroupName}`
}

/**
 * @param {Object} plans  flight plans keyed by AID
 * @param {Object} units  live units keyed by id
 * @returns {{ linkOf: (unitKey) => ({ aid, exact, groupAids } | null) }}
 *   groupAids: every plan AID of the unit's DCS group, in slot order.
 */
export function buildPlanLinks(plans, units) {
  const flights = new Map()  // mission flightId -> pseudo-flight
  const groupAids = new Map() // group key -> AIDs
  const sorted = Object.values(plans ?? {})
    .filter((p) => p?.mission)
    .sort((a, b) => (a.mission.unitIndex ?? 0) - (b.mission.unitIndex ?? 0))

  for (const plan of sorted) {
    const m = plan.mission
    let flight = flights.get(m.flightId)
    if (!flight) {
      flight = {
        flightId:     m.flightId,
        coalition:    m.coalition,
        dcsGroupId:   m.dcsGroupId,
        dcsGroupName: m.dcsGroupName,
        groupName:    (m.dcsGroupName ?? '').trim(),
        units:        [],
        aids:         [],
        groupKey:     groupKeyOf(m),
      }
      flights.set(m.flightId, flight)
    }
    flight.units.push({ unitId: m.unitId, unitName: m.unitName, position: m.position })
    flight.aids.push(plan.aid)
    if (!groupAids.has(flight.groupKey)) groupAids.set(flight.groupKey, [])
    groupAids.get(flight.groupKey).push(plan.aid)
  }

  const byUnit = new Map()
  if (flights.size) {
    const list = [...flights.values()]
    const links = buildFlightLinks(list, units)
    for (const flight of list) {
      flight.units.forEach((_, index) => {
        const link = links.live(flight, index)
        if (!link) return
        byUnit.set(String(link.key), {
          aid:       flight.aids[index],
          exact:     link.via !== 'player',
          groupAids: groupAids.get(flight.groupKey),
        })
      })
    }
  }

  return { linkOf: (unitKey) => byUnit.get(String(unitKey)) ?? null }
}

// buildPlanLinks for the latest plans + units, rebuilt only when either
// object (or the source) changes. Its own cache: the ATO's getFlightLinks
// runs over a different flights array and would evict this one every call.
let cache = null
export function getPlanLinks(plans, units) {
  const ids = dcsUnitIdReliable()
  const source = useSessionStore.getState().sourceType
  if (!cache || cache.plans !== plans || cache.units !== units || cache.ids !== ids || cache.source !== source) {
    cache = { plans, units, ids, source, links: buildPlanLinks(plans, units) }
  }
  return cache.links
}
