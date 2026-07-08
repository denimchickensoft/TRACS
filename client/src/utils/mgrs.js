// Real-world MGRS/UTM grid math — standard NGA Military Grid Reference
// System, not DCS's own per-theatre grid (see utils/transverseMercator.js).
// Reuses the same Krüger TM engine with real UTM zone parameters (6° zones,
// k0=0.9996, 500,000m false easting) so this matches what DCS's own
// F10/kneeboard MGRS readout shows — confirmed 2026-07-07 against real
// in-game coordinates.

const ROW_LETTERS = 'ABCDEFGHJKLMNPQRSTUV' // 20 letters, I/O skipped
const COL_SETS    = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ']
const BAND_LETTERS = 'CDEFGHJKLMNPQRSTUVWX' // 20 bands, -80° to 84°, 8° each (X is 12°)

export function utmZoneNumber(lng) {
  const norm = ((lng + 180) % 360 + 360) % 360
  return Math.floor(norm / 6) + 1
}

export function utmCentralMeridian(zone) {
  return zone * 6 - 183
}

export function utmZoneParams(zone, hemisphere) {
  return {
    central_meridian: utmCentralMeridian(zone),
    false_easting: 500000,
    false_northing: hemisphere === 'S' ? 10000000 : 0,
    scale_factor: 0.9996,
  }
}

export function latBand(lat) {
  if (lat >= 84) return 'X'
  if (lat < -80) return 'C'
  const idx = Math.min(19, Math.max(0, Math.floor((lat + 80) / 8)))
  return BAND_LETTERS[idx]
}

// zone/easting/northing (meters, in that zone's own UTM frame) -> two-letter
// 100,000m square ID. Column set cycles every 3 zones; row sequence shifts
// by 5 on even zones — both per the NGA MGRS spec.
export function mgrs100kSquareId(zone, easting, northing) {
  const colSet = COL_SETS[(zone - 1) % 3]
  const colIdx = (Math.floor(easting / 100000) - 1) % 8
  const col = colSet[(colIdx + 8) % 8]

  let rowIdx = Math.floor(northing / 100000) % 20
  if (zone % 2 === 0) rowIdx += 5
  rowIdx = ((rowIdx % 20) + 20) % 20
  const row = ROW_LETTERS[rowIdx]

  return col + row
}
