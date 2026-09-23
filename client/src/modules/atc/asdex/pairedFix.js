// ASDE-X Data Block field H — "paired fix or departure gate information", a
// three-letter fix ID from the flight plan's routing and destination (CRC).
// CRC derives it from facility-configured fix pairings; TRACS has no such
// config, so:
//   - first route token that's a known fix/navaid, first three letters only
//   - no known fix in the route → the destination airport, four characters,
//     unless the destination is this facility → blank
// facilityIds: Set of uppercase identifiers for this facility (ICAO + DCS name).
// fixIds: Set of uppercase fix/navaid ids for the theatre.
export function pairedFix(plan, facilityIds, fixIds) {
  if (!plan) return ''
  for (const tok of (plan.rte ?? '').toUpperCase().split(/[\s.]+/)) {
    if (!tok || tok === 'DCT') continue
    if (fixIds.has(tok)) return tok.slice(0, 3)
  }
  const dest = (plan.dest ?? '').trim().toUpperCase()
  if (facilityIds.has(dest)) return ''
  return dest.slice(0, 4)
}
