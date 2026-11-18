// Links live units to the imported mission's flights (parseMission.js
// findAtoFlights), the same way for every data source:
//
//   1. Group. Olympus and the exporter host send the numeric DCS group ID;
//      every source sends the group name (the exporter client and Tacview
//      only that - Tacview in `groupID`). DCS group names are unique
//      mission-wide, but missions often have names that differ only by
//      spaces ("Lot 20", "Lot 20 "): the exact name wins, and the trimmed
//      name is a fallback only when one group has it.
//   2. Unit within the group. The DCS unit ID where the source's IDs are the
//      mission's (dcsUnitIdReliable), else the unit name: Olympus and the
//      exporter host carry it in `callsign` for every unit, and every source
//      carries it in `unitName` for AI.
//   3. Humans left over (the exporter client and Tacview report a player's
//      MP nickname instead of the unit name): the element digit of the
//      callsign in that nickname picks the aircraft position ("HAWK 1-2"
//      takes the group's position-2 unit), else the first free unit. A
//      human is one the source flags (Olympus sends the flag only when set);
//      Tacview flags nobody, and reports AI by their unit names, so there a
//      unit in the group matching none of its unit names is the player.
//
// Units spawned at runtime (script clones, dynamic slots) are in no mission
// group and link to nothing.

import { dcsUnitIdReliable } from './callsign.js'
import { shapedCallsignOf } from './callsignShape.js'
import { useSessionStore } from '../store/session.js'

const trim = (s) => (typeof s === 'string' ? s.trim() : '')

// A mission group's identity: its DCS ID, or for a static template (no real
// ID) its coalition + name.
function groupKeyOf(flight) {
  return flight.dcsGroupId != null ? `id:${flight.dcsGroupId}` : `name:${flight.coalition}:${flight.dcsGroupName ?? flight.groupName}`
}

function liveGroupName(unit) {
  if (typeof unit.groupName === 'string' && unit.groupName.trim()) return unit.groupName
  return typeof unit.groupID === 'string' ? unit.groupID : ''
}

function addTo(map, key, value) {
  if (!map.has(key)) map.set(key, new Set())
  map.get(key).add(value)
}

const onlyOne = (set) => (set?.size === 1 ? [...set][0] : undefined)

function elementDigit(unit) {
  return shapedCallsignOf(unit)?.element ?? null
}

// A unit left over in its group after the unit-name match that is a player.
// Tacview flags nobody human; any other source's missing flag means false.
function isLeftoverPlayer(unit, sourceFlagsHumans) {
  return sourceFlagsHumans ? unit.human === true : true
}

// Whether a link is a player: the source flags it human, or it was placed by
// its callsign rather than matched by its unit name.
export function isPlayerLink(link) {
  return !!link && (link.unit.human === true || link.via === 'player')
}

export const missionUnitKey = (flightId, index) => `${flightId}:${index}`

// buildFlightLinks for the latest flights + live units, rebuilt only when
// either object (or the source) changes, so per-unit callers
// (scope commands, the ATO, the FRAG) share one pass.
let cache = null
export function getFlightLinks(flights, liveUnits) {
  const ids = dcsUnitIdReliable()
  const source = useSessionStore.getState().sourceType
  if (!cache || cache.flights !== flights || cache.liveUnits !== liveUnits || cache.ids !== ids || cache.source !== source) {
    cache = { flights, liveUnits, ids, source, links: buildFlightLinks(flights, liveUnits) }
  }
  return cache.links
}

/**
 * @returns {{
 *   live: (flight, unitIndex) => ({ key, unit, via: 'id'|'name'|'player' } | null),
 *   flightOf: (liveKey) => ({ flightId, unitIndex } | null),
 * }}
 */
export function buildFlightLinks(flights, liveUnits) {
  const groups = new Map()       // groupKey -> [{ flight, index, unit }]
  const byDcsGroupId = new Map() // numeric DCS group ID -> groupKey
  const byName = new Map()       // exact group name -> Set(groupKey)
  const byTrimmed = new Map()    // trimmed group name -> Set(groupKey)
  const byUnitId = new Map()     // mission unit ID -> slot

  for (const flight of flights ?? []) {
    if (flight.manual) continue
    const gk = groupKeyOf(flight)
    if (!groups.has(gk)) groups.set(gk, [])
    ;(flight.units ?? []).forEach((unit, index) => {
      const slot = { flight, index, unit }
      groups.get(gk).push(slot)
      if (unit.unitId != null) byUnitId.set(unit.unitId, slot)
    })
    if (flight.dcsGroupId != null) byDcsGroupId.set(flight.dcsGroupId, gk)
    const exact = flight.dcsGroupName ?? flight.groupName
    if (trim(exact)) {
      addTo(byName, exact, gk)
      addTo(byTrimmed, trim(exact), gk)
    }
  }

  const idsReliable = dcsUnitIdReliable()
  const sourceFlagsHumans = useSessionStore.getState().sourceType !== 'tacview'
  const claimed = new Map()  // missionUnitKey -> { key, unit }
  const liveToSlot = new Map()
  const leftover = new Map() // groupKey -> [{ key, unit }]

  const claim = (slot, key, unit, via) => {
    const mk = missionUnitKey(slot.flight.flightId, slot.index)
    if (claimed.has(mk) || liveToSlot.has(key)) return false
    claimed.set(mk, { key, unit, via })
    liveToSlot.set(key, { flightId: slot.flight.flightId, unitIndex: slot.index })
    return true
  }

  for (const [key, unit] of Object.entries(liveUnits ?? {})) {
    if (idsReliable && unit.unitID != null) {
      const slot = byUnitId.get(unit.unitID)
      if (slot && claim(slot, key, unit, 'id')) continue
    }

    let gk = typeof unit.groupID === 'number' ? byDcsGroupId.get(unit.groupID) : undefined
    if (!gk) {
      const name = liveGroupName(unit)
      gk = onlyOne(byName.get(name)) ?? onlyOne(byTrimmed.get(trim(name)))
    }
    if (!gk) continue

    const names = [trim(unit.callsign), trim(unit.unitName)].filter(Boolean)
    const slot = groups.get(gk).find((s) => s.unit.unitName && names.includes(s.unit.unitName))
    if (slot && claim(slot, key, unit, 'name')) continue
    if (isLeftoverPlayer(unit, sourceFlagsHumans)) {
      if (!leftover.has(gk)) leftover.set(gk, [])
      leftover.get(gk).push({ key, unit })
    }
  }

  // Players with an element digit place first, so a player without one
  // can't take the slot another's digit points at.
  for (const [gk, players] of leftover) {
    const free = () => groups.get(gk).filter((s) => !claimed.has(missionUnitKey(s.flight.flightId, s.index)))
    const withDigit = players.map((p) => ({ ...p, digit: elementDigit(p.unit) }))
    withDigit.sort((a, b) => (a.digit == null) - (b.digit == null))
    for (const p of withDigit) {
      const open = free()
      const slot = (p.digit != null && open.find((s) => s.unit.position === p.digit)) || open[0]
      if (slot) claim(slot, p.key, p.unit, 'player')
    }
  }

  return {
    live: (flight, unitIndex) => claimed.get(missionUnitKey(flight.flightId, unitIndex)) ?? null,
    flightOf: (liveKey) => liveToSlot.get(String(liveKey)) ?? null,
  }
}
