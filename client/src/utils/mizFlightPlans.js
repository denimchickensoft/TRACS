// Maps parseMission.js's findAtoFlights() output onto flight-plan store
// records.

import { preloadAirdromes, getAirdromeName } from './airdromes.js'
import { matchFixName } from './fixMatch.js'
import { formatIcaoRoutePoint } from './coords.js'
import { AID_MAX_LEN } from './callsign.js'
import { M_TO_FT } from './units.js'
import { getIcaoMapping } from './icaoMapping.js'


// ALT is stored as hundreds of feet MSL (e.g. 35,000 ft -> "350"), the
// flight-plan store's field convention.
function metersToAltField(m) {
  return String(Math.round(m * M_TO_FT / 100))
}

const loadIcaoMapping = getIcaoMapping

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

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

// A unit name's AID: the name stripped to letters and digits, uppercase.
// Uncut when that fits AID_MAX_LEN; otherwise the trailing digits (the slot
// numbers, "Akrotiri Hornet-3" -> AKROTIRIHORN3) are kept and the name part
// is cut to fit.
function preferredAid(raw) {
  if (raw.length <= AID_MAX_LEN) return raw
  const digits = raw.match(/\d*$/)[0].slice(-(AID_MAX_LEN - 1))
  return raw.slice(0, AID_MAX_LEN - digits.length) + digits
}

// When a preferred AID is taken, swaps the last letter of the name part
// for A, B, C... ("A10C II-1" -> AKROTIRIA10A1 while AKROTIRIA10C1 is the
// A10C group's), then the letter before it, and so on.
function freeAid(aid, taken) {
  if (!taken.has(aid)) return aid
  const nameLen = aid.length - aid.match(/\d*$/)[0].length
  for (let i = nameLen - 1; i >= 0; i--) {
    for (const letter of LETTERS) {
      const next = aid.slice(0, i) + letter + aid.slice(i + 1)
      if (!taken.has(next)) return next
    }
  }
  // All digits (a numeric unit name): a letter in front, cutting the end.
  for (const letter of LETTERS) {
    const next = (letter + aid).slice(0, AID_MAX_LEN)
    if (!taken.has(next)) return next
  }
  return aid
}

// One AID per mission unit, unique within its coalition, the same for every
// controller who loads the mission: names that fit keep their AID, in
// mission order; the cut ones follow, in mission order, each moved off a
// taken AID by freeAid. Linking goes by mission slot (plan.mission), so an
// AID needn't match the live name.
export function assignAids(entries) {
  const taken = new Map() // coalition -> Set
  const ordered = [
    ...entries.filter((e) => e.raw.length <= AID_MAX_LEN),
    ...entries.filter((e) => e.raw.length > AID_MAX_LEN),
  ]
  for (const e of ordered) {
    const key = e.coalition ?? ''
    if (!taken.has(key)) taken.set(key, new Set())
    const set = taken.get(key)
    e.aid = freeAid(preferredAid(e.raw), set)
    set.add(e.aid)
  }
}

// flights: findAtoFlights() output. theatre: mission.theatre.
// One flight plan per UNIT (not per group) -- every flight member files
// independently (e.g. FORD11 and FORD12 both), sharing the group's route/
// dep/dest/alt/rmk but each with its own aid/typ/dcsUnitId.
export async function mapMizFlightPlans(flights, theatre) {
  await preloadAirdromes(theatre)
  const icaoMapping = await loadIcaoMapping()
  const theatreIcao = icaoMapping[(theatre ?? '').toLowerCase()] ?? {}

  const entries = []
  for (const flight of flights) {
    for (const unit of flight.units ?? []) {
      const raw = ((unit.unitName ?? '').replace(/[^A-Za-z0-9]/g, '') || (flight.name ?? '').replace(/[^A-Za-z0-9]/g, '')).toUpperCase()
      if (raw) entries.push({ unit, raw, coalition: flight.coalition })
    }
  }
  assignAids(entries)
  const aidOf = new Map(entries.map((e) => [e.unit, e.aid]))

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

    for (const [unitIndex, unit] of flight.units.entries()) {
      const aid = aidOf.get(unit)
      if (!aid) continue

      results.push({
        aid,
        typ: unit.type ?? '',
        eq: '',
        dep: dep.code,
        dest: dest.code,
        spd: '',
        alt: maxAlt,
        rte,
        rmk,
        flightRules: 'IFR',
        source: flight.source === 'stm' ? 'stm' : 'miz',
        // DCS's own internal unit ID (matches Olympus's live `unitID` field
        // reliably -- see utils/callsign.js findFlightPlanAid). Lets STARS
        // correlate a live track to this plan even when the mission's true
        // callsign.name ("Texaco21") doesn't survive into live telemetry for
        // single-ship groups, where Olympus's unitName/callsign both just
        // report the bare unit name ("Texaco 2"). Always null for a static
        // template, whose unit IDs are file-local (parseMission.js), so its
        // plans correlate by AID only.
        dcsUnitId: unit.unitId ?? null,
        // The mission slot this plan was filed for, so a live aircraft can be
        // linked to it the way the ATO links one to its flight
        // (utils/planLinks.js): by group, then unit name, then the element
        // digit of a player's MP callsign.
        mission: {
          flightId:     flight.flightId,
          coalition:    flight.coalition ?? null,
          dcsGroupId:   flight.dcsGroupId ?? null,
          dcsGroupName: flight.dcsGroupName ?? flight.groupName ?? '',
          unitIndex,
          unitName:     unit.unitName ?? '',
          unitId:       unit.unitId ?? null,
          position:     unit.position ?? null,
        },
      })
    }
  }
  return results
}
