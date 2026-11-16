// The ATO rows one imported flight shows: a row per MP flight callsign its
// players (or .renamed aircraft) fly under, plus a base row for the rest
// (open slots, AI). RMD1 with HAWK 1-1, HAWK 1-2 and VIPER 2-2 slotted in is
// rows HAWK1 (units 1, 2), VIPER2 (unit 3) and RMD1 (unit 4). The base row
// is left out once every unit is in a callsign row.
//
// `row` identifies a row within its flight: the callsign, '' for the base
// row of a flight that has callsign rows, null for a flight that is one row.

import { resolveCallsign } from '../../utils/callsign.js'
import { getFlightLinks, isPlayerLink } from '../../utils/flightLinks.js'
import { useAtcStore } from '../../store/atc.js'
import { useAbmMissionStore } from '../../store/abmMission.js'
import { useUnitsStore } from '../../store/units.js'
import { parseFlightElement } from './canvas/drawAbmContacts.js'

function hasOverride(unit) {
  return !!useAtcStore.getState().callsignOverrides[String(unit.id)]
}

// The flight-level callsign a linked unit flies under ("HAWK11" -> "HAWK1"),
// or null when it shows its unit name (AI, open slot).
export function liveFlightCallsign(link) {
  if (!link || !(isPlayerLink(link) || hasOverride(link.unit))) return null
  return parseFlightElement(link.unit)?.flightKey ?? (resolveCallsign(link.unit).toUpperCase() || null)
}

/**
 * @returns {{ row: string|null, callsign: string|null, unitIndices: number[] }[]}
 */
export function flightRows(flight, links) {
  const all = (flight.units ?? []).map((_, i) => i)
  if (flight.manual) return [{ row: null, callsign: null, unitIndices: all }]
  const byCallsign = new Map()
  const base = []
  for (const i of all) {
    const cs = liveFlightCallsign(links.live(flight, i))
    if (!cs) { base.push(i); continue }
    if (!byCallsign.has(cs)) byCallsign.set(cs, [])
    byCallsign.get(cs).push(i)
  }
  if (byCallsign.size === 0) return [{ row: null, callsign: null, unitIndices: all }]
  const rows = [...byCallsign].map(([cs, unitIndices]) => ({ row: cs, callsign: cs, unitIndices }))
  if (base.length) rows.push({ row: '', callsign: null, unitIndices: base })
  return rows
}

// The unit indices the FRAG shows for a selection: the selected row's, or
// the whole flight when the selection is the whole flight or its row is gone
// (its players left).
export function selectedUnitIndices(flight, links, row) {
  const all = (flight.units ?? []).map((_, i) => i)
  if (row == null) return all
  return flightRows(flight, links).find((r) => r.row === row)?.unitIndices ?? all
}

// The ATO row a live unit shows in, so a FRAG opened from the scope matches
// clicking that row: its MP callsign row, else the base row. null when the
// unit isn't linked to `flight` or the flight is a single row.
export function rowOfLiveUnit(flight, links, liveKey) {
  if (!flight || flight.manual) return null
  const slot = links.flightOf(String(liveKey))
  if (!slot || slot.flightId !== flight.flightId) return null
  return flightRows(flight, links).find((r) => r.unitIndices.includes(slot.unitIndex))?.row ?? null
}

// Opens the FRAG on `flightId` at the row the live `unit` shows in.
export function selectFlightForUnit(flightId, unit) {
  const store = useAbmMissionStore.getState()
  const flight = store.flights.find((f) => f.flightId === flightId)
  const links = getFlightLinks(store.flights, useUnitsStore.getState().units)
  store.selectFlight(flightId, { row: unit?.id != null ? rowOfLiveUnit(flight, links, unit.id) : null })
}
