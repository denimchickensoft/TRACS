// CSV bulk IFF-code assignment for ABM's FRAG. Hand-rolled parser matching
// csvFlightPlans.js's style/level of robustness — a different feature/
// module (this one feeds useAbmMissionStore().applyIffCsv, not
// store/flightPlans.js), not shared code.
//
// Assign-only: rows are matched by callsign against units already present
// across every known FRAG flight (imported or manual) — this parser only
// produces the candidate rows, matching/skipping happens in
// abmMission.js's applyIffCsv.

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

// @returns {Array<{callsign, mode1, mode2, mode3}>} mode fields are 1-4
//   digit strings or null when the column is absent/blank for that row.
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

    rows.push({
      callsign,
      mode1: get('mode1').replace(/\D/g, '').slice(0, 4) || null,
      mode2: get('mode2').replace(/\D/g, '').slice(0, 4) || null,
      mode3: get('mode3').replace(/\D/g, '').slice(0, 4) || null,
    })
  }

  if (rows.length === 0) throw new Error('No IFF assignment rows found in this CSV.')
  return rows
}
