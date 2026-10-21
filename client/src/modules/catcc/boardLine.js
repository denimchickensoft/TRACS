/**
 * Status board row entry from the CATCC command line, in two forms:
 *
 *   <side> <fields> ENTER   the row with this side number, added if missing
 *   <fields> + slew         the clicked aircraft's row: its correlated side
 *                           number's row, else the row linked to the unit,
 *                           else a new row linked to it with its callsign
 *
 * Fields: <bcn> (bare 4 digits) C<callsign> P<pilot> T<type> M<mission>
 * B<bingo> R<app rad> D<dme> A<angels> E<eat> S<state>, plus a bare side
 * number in the slew form. A side number is always 3 digits (012). Only the fields given change, a
 * bare letter clears its field, and any bad field rejects the whole line.
 * Values are stored as the board's own cells would commit them.
 */

import { useStatusBoardStore } from '../../store/statusBoard.js'
import { COLUMNS, isValidDecimal, isValidTime, resolveEat } from './statusBoardColumns.js'
import { getMissionUtcSeconds } from '../../utils/useMissionClock.js'
import { resolveCallsign } from '../../utils/callsign.js'

const LETTER_FIELDS = { C: 'callsign', P: 'pilot', T: 'type', M: 'msn', B: 'bingo', R: 'appRad', D: 'dme', A: 'angels', E: 'eat', S: 'state' }

// The value to store, or null if invalid.
function fieldValue(field, v, utcSeconds) {
  if (!v) return ''
  switch (field) {
    // A whole number is whole thousands: 5 is 5.0
    case 'bingo':
    case 'state': {
      if (!/^\d*\.?\d*$/.test(v)) return null
      let n = v.includes('.') ? v : v + '.0'
      if (n.startsWith('.')) n = '0' + n
      return isValidDecimal(n) ? n : null
    }
    case 'appRad': {
      if (!/^\d{1,3}$/.test(v)) return null
      const r = v.padStart(3, '0') === '000' ? '360' : v.padStart(3, '0')
      return parseInt(r, 10) <= 360 ? r : null
    }
    case 'dme':
    case 'angels':
      return /^\d{1,3}$/.test(v) ? v : null
    case 'eat': {
      if (!/^\d{1,4}$/.test(v)) return null
      const t = resolveEat(v, utcSeconds)
      return /^\d{4}$/.test(t) && isValidTime(t) ? t : null
    }
    default:
      return v.length <= COLUMNS.find((c) => c.field === field).maxLen ? v : null
  }
}

// { fields } or { error }
function parseFields(tokens, allowSide) {
  const utcSeconds = getMissionUtcSeconds()
  const fields = {}
  for (const tok of tokens) {
    const bare  = /^\d{4}$/.test(tok) ? 'bcn' : allowSide && /^\d{3}$/.test(tok) ? 'sideNumber' : null
    const field = bare ?? LETTER_FIELDS[tok[0]]
    if (!field || field in fields) return { error: `FORMAT: ${tok}` }
    const raw = bare ? tok : tok.slice(1)
    // Two-digit EATs resolve against the mission clock
    if (field === 'eat' && raw && raw.length <= 2 && utcSeconds == null) return { error: 'NO MISSION CLOCK' }
    const v = bare ? tok : fieldValue(field, raw, utcSeconds)
    if (v == null) return { error: `FORMAT: ${tok}` }
    fields[field] = v
  }
  return { fields }
}

// Error string, or null once applied. row is the board row to update, or
// null to add one starting from init.
function apply(entries, row, init, fields) {
  const others = entries.filter((e) => e !== row)
  if (fields.callsign && others.some((e) => e.callsign === fields.callsign)) return `DUP CALLSIGN: ${fields.callsign}`
  if (fields.sideNumber && others.some((e) => e.sideNumber === fields.sideNumber)) return `DUP SIDE: ${fields.sideNumber}`
  useStatusBoardStore.getState().applyEntryLine(row?.id ?? null, init, fields)
  return null
}

// <side> <fields> ENTER. parts is the uppercased, space-split command line.
export function boardLineBySide(parts) {
  const side = parts[0]
  const { fields, error } = parseFields(parts.slice(1), false)
  if (error) return [error]
  const { entries } = useStatusBoardStore.getState()
  const err = apply(entries, entries.find((e) => e.sideNumber === side) ?? null, { sideNumber: side }, fields)
  return err ? [err] : []
}

// <fields> + slew. Returns an error string, or null on success.
export function boardLineByTarget(rest, target, correlations) {
  if (!target) return 'NO TARGET'
  const tokens = rest.trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return 'FORMAT'
  const { fields, error } = parseFields(tokens, true)
  if (error) return error
  const { entries } = useStatusBoardStore.getState()
  const uid  = String(target.unitId)
  const side = correlations?.[uid]
  const row  = (side && entries.find((e) => e.sideNumber === side))
            || entries.find((e) => e.unitId != null && String(e.unitId) === uid)
            || null
  const callsign = resolveCallsign(target.unit)
  const init = { unitId: target.unitId, callsign: entries.some((e) => e.callsign === callsign) ? '' : callsign }
  return apply(entries, row, init, fields)
}
