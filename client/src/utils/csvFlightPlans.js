// CSV bulk flight-plan import. Hand-rolled parser (consistent with
// parseMission.js/luaTable.js -- no CSV dependency exists in the codebase
// and none is needed for this controlled, simple format). See
// resources/specs/pilot-flightplan-ingestion-spec.md §5.

import { fixNameExists } from './fixMatch.js'
import { AID_MAX_LEN } from './callsign.js'

const COLUMNS = ['aid', 'typ', 'eq', 'dep', 'dest', 'spd', 'alt', 'rte', 'rmk', 'flightRules']

// Splits one CSV line into fields, honoring "quoted, with a comma inside"
// fields and doubled-quote ("") escaping -- the minimum needed since RMK is
// free text that may itself contain commas.
function splitCsvLine(line) {
  const fields = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      fields.push(field); field = ''
    } else {
      field += c
    }
  }
  fields.push(field)
  return fields.map((f) => f.trim())
}

// Parses CSV text into flight-plan candidates for the import modal.
// Each candidate carries `_rteWarnings` (route tokens not found in theatre
// navdata) for the controller to review before committing -- the route
// field itself is trusted as typed (no coordinate cross-check possible for
// a human-authored CSV, unlike .miz/DTC -- see spec §5).
export function parseCsvFlightPlans(text) {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0)
  if (lines.length === 0) throw new Error('CSV file is empty.')

  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase())
  const colIndex = {}
  for (const col of COLUMNS) {
    const idx = header.indexOf(col.toLowerCase())
    if (idx !== -1) colIndex[col] = idx
  }
  if (colIndex.aid == null) throw new Error('CSV is missing a required "aid" column.')

  const flightPlans = []
  for (let i = 1; i < lines.length; i++) {
    const fields = splitCsvLine(lines[i])
    const get = (col) => (colIndex[col] != null ? (fields[colIndex[col]] ?? '') : '')

    const aid = get('aid').toUpperCase().slice(0, AID_MAX_LEN)
    if (!aid) continue

    const rte = get('rte')
    const tokens = rte.split(/\s+/).filter(Boolean)
    const rteWarnings = tokens.filter((t) => !fixNameExists(t))

    flightPlans.push({
      aid,
      typ:  get('typ').toUpperCase(),
      eq:   get('eq').toUpperCase(),
      dep:  get('dep').toUpperCase(),
      dest: get('dest').toUpperCase(),
      spd:  get('spd'),
      alt:  get('alt'),
      rte,
      rmk:  get('rmk'),
      flightRules: get('flightRules').toUpperCase() || 'IFR',
      source: 'csv',
      _rteWarnings: rteWarnings,
    })
  }

  if (flightPlans.length === 0) throw new Error('No flight plan rows found in this CSV.')
  return flightPlans
}
