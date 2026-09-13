// Maps parseMission.js's findAtoFlights() output onto flight-plan store
// records. See resources/specs/pilot-flightplan-ingestion-spec.md §4.

import { preloadAirdromes, getAirdromeName } from './airdromes.js'
import { matchFixName } from './fixMatch.js'
import { formatIcaoRoutePoint } from './coords.js'

const M_TO_FT = 3.28084

// ALT is stored as hundreds of feet MSL (e.g. 35,000 ft -> "350"), per
// resources/specs/flightplans-strips-spec.md's field convention.
function metersToAltField(m) {
  return String(Math.round(m * M_TO_FT / 100))
}

let _icaoMapping = null
async function loadIcaoMapping() {
  if (_icaoMapping) return _icaoMapping
  try {
    const r = await fetch('/icaoMapping.json')
    _icaoMapping = r.ok ? await r.json() : {}
  } catch {
    _icaoMapping = {}
  }
  return _icaoMapping
}

function routeToken(point) {
  const matched = matchFixName(point.name, point.lat, point.lng)
  if (matched) return matched
  if (point.lat != null && point.lng != null) return formatIcaoRoutePoint(point.lat, point.lng)
  return point.name || '?'
}

// Resolves a launch/recovery ref (from parseMission.js's buildLaunch/
// buildRecovery) to { code, remark } -- code is an ICAO airport code or the
// real ICAO "ZZZZ" (aerodrome not listed) placeholder for a carrier/airstart/
// unresolved airbase, with `remark` carrying the DEP//DEST/ detail in that
// case (also a real ICAO Item-18 convention).
async function resolveFieldRef(ref, theatreIcao, firstRoutePoint) {
  if (ref?.type === 'airbase') {
    const name = getAirdromeName(ref.theatre, ref.airdromeId)
    const icao = name ? theatreIcao[name] : null
    if (icao) return { code: icao, remark: null }
    return { code: 'ZZZZ', remark: name ?? `AIRDROME ${ref.airdromeId}` }
  }
  if (ref?.type === 'carrier') {
    return { code: 'ZZZZ', remark: ref.carrierName ?? ref.carrierAbbrev ?? 'CARRIER' }
  }
  // airstart / unknown -- no name at all, fall back to the point's own coords
  if (firstRoutePoint?.lat != null && firstRoutePoint?.lng != null) {
    return { code: 'ZZZZ', remark: formatIcaoRoutePoint(firstRoutePoint.lat, firstRoutePoint.lng) }
  }
  return { code: 'ZZZZ', remark: null }
}

// flights: findAtoFlights() output. theatre: mission.theatre.
// One flight plan per UNIT (not per group) -- every flight member files
// independently (e.g. FORD11 and FORD12 both), sharing the group's route/
// dep/dest/alt/rmk but each with its own aid/typ/dcsUnitId.
export async function mapMizFlightPlans(flights, theatre) {
  await preloadAirdromes(theatre)
  const icaoMapping = await loadIcaoMapping()
  const theatreIcao = icaoMapping[(theatre ?? '').toLowerCase()] ?? {}

  const results = []
  for (const flight of flights) {
    if (!flight.units?.length) continue

    const altsM = flight.route.map((p) => p.alt).filter((a) => a != null)
    const maxAlt = altsM.length ? metersToAltField(Math.max(...altsM)) : ''

    const dep = await resolveFieldRef(flight.launch, theatreIcao, flight.route[0])
    const dest = await resolveFieldRef(flight.recovery, theatreIcao, flight.route[flight.route.length - 1])

    const rmkParts = []
    if (dep.remark) rmkParts.push(`DEP/${dep.remark}`)
    if (dest.remark) rmkParts.push(`DEST/${dest.remark}`)

    const rte = flight.route.map(routeToken).join(' ')
    const rmk = rmkParts.join(' ')

    for (const unit of flight.units) {
      const aid = unit.callsign || flight.name
      if (!aid) continue

      results.push({
        aid: aid.toUpperCase(),
        typ: unit.type ?? '',
        eq: '',
        dep: dep.code,
        dest: dest.code,
        spd: '',
        alt: maxAlt,
        rte,
        rmk,
        flightRules: 'IFR',
        source: 'miz',
        // DCS's own internal unit ID (matches Olympus's live `unitID` field
        // reliably -- see utils/callsign.js findFlightPlanAid). Lets STARS
        // correlate a live track to this plan even when the mission's true
        // callsign.name ("Texaco21") doesn't survive into live telemetry for
        // single-ship groups, where Olympus's unitName/callsign both just
        // report the bare unit name ("Texaco 2").
        dcsUnitId: unit.unitId ?? null,
        _groupId: flight.groupId,
      })
    }
  }
  return results
}
