// CSV bulk IFF-code assignment for ABM's FRAG. Hand-rolled parser matching
// csvFlightPlans.js's style/level of robustness — a different feature/
// module (this one feeds useAbmMissionStore().applyIffCsv, not
// store/flightPlans.js), not shared code.
//
// Assign-only: rows are matched by callsign against units already present
// across every known FRAG flight (imported or manual) — this parser only
// produces the candidate rows, matching/skipping happens in
// abmMission.js's applyIffCsv.
//
// Codes get the same octal check as FRAG and .m1/.m2/.m3, except a short
// code is zero-padded first (spreadsheets strip leading zeros, so 0400
// arrives as 400). A code that still fails is dropped from its row on its
// own; the row's other codes still apply.

import { IFF_CODE_LEN, isValidIffCode } from './transponder.js'

const MODES = ['mode1', 'mode2', 'mode3']
const COLUMNS = ['callsign', 'mode1', 'mode2', 'mode3']

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

// @returns {Array<{callsign, mode1, mode2, mode3, dropped}>} each mode field
//   is a valid code string, null when the column is absent/blank for that
//   row (clears that mode), or undefined when its code was invalid (left
//   unchanged). `dropped` lists the invalid entries, e.g. ['M3 8899'].
export function parseIffCsv(text) {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0)
  if (lines.length === 0) throw new Error('CSV file is empty.')

  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase())
  const colIndex = {}
  for (const col of COLUMNS) {
    const idx = header.indexOf(col)
    if (idx !== -1) colIndex[col] = idx
  }
  if (colIndex.callsign == null) throw new Error('CSV is missing a required "callsign" column.')

  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const fields = splitCsvLine(lines[i])
    const get = (col) => (colIndex[col] != null ? (fields[colIndex[col]] ?? '') : '')

    const callsign = get('callsign').toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!callsign) continue

    const row = { callsign, dropped: [] }
    for (const mode of MODES) {
      const raw = get(mode)
      if (!raw) { row[mode] = null; continue }
      const len = IFF_CODE_LEN[mode]
      const code = /^\d+$/.test(raw) && raw.length < len ? raw.padStart(len, '0') : raw
      if (isValidIffCode(mode, code)) row[mode] = code
      else { row[mode] = undefined; row.dropped.push(`M${mode.slice(4)} ${raw}`) }
    }
    rows.push(row)
  }

  if (rows.length === 0) throw new Error('No IFF assignment rows found in this CSV.')
  return rows
}
