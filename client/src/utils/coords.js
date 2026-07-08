// Real-world position formatting for cursor readouts (ABM .coords).
// MGRS piece reuses the same real UTM math (mgrs.js/transverseMercator.js)
// that already backs the ABM MGRS grid overlay, so the readout always
// matches the drawn grid lines exactly.

import { utmZoneNumber, utmZoneParams, mgrs100kSquareId, latBand } from './mgrs.js'
import { tmForward } from './transverseMercator.js'

function pad(n, width) {
  return String(Math.trunc(n)).padStart(width, '0')
}

// D°M'S" — degrees/minutes/whole-to-2-decimal seconds. Default (.dms) format.
// Latitude degrees max out at 90 (2 digits); longitude at 180 (3 digits).
export function formatDMS(lat, lng, secDecimals = 2) {
  const fmt = (value, degWidth, positiveLetter, negativeLetter) => {
    const letter = value >= 0 ? positiveLetter : negativeLetter
    const abs = Math.abs(value)
    const deg = Math.floor(abs)
    const minFloat = (abs - deg) * 60
    const min = Math.floor(minFloat)
    const sec = (minFloat - min) * 60
    return `${letter}${pad(deg, degWidth)}°${pad(min, 2)}'${sec.toFixed(secDecimals).padStart(secDecimals + 3, '0')}"`
  }
  return `${fmt(lat, 2, 'N', 'S')} ${fmt(lng, 3, 'E', 'W')}`
}

// D°M.mmm' — degrees + decimal minutes (no seconds field). .ddm format.
export function formatDDM(lat, lng, minDecimals = 3) {
  const fmt = (value, degWidth, positiveLetter, negativeLetter) => {
    const letter = value >= 0 ? positiveLetter : negativeLetter
    const abs = Math.abs(value)
    const deg = Math.floor(abs)
    const min = (abs - deg) * 60
    return `${letter}${pad(deg, degWidth)}°${min.toFixed(minDecimals).padStart(minDecimals + 3, '0')}'`
  }
  return `${fmt(lat, 2, 'N', 'S')} ${fmt(lng, 3, 'E', 'W')}`
}

// Real-world MGRS at 1m precision (5-digit easting/northing).
export function formatMGRS(lat, lng) {
  const zone = utmZoneNumber(lng)
  const hemisphere = lat < 0 ? 'S' : 'N'
  const params = utmZoneParams(zone, hemisphere)
  const { easting, northing } = tmForward(lat, lng, params)
  const sq = mgrs100kSquareId(zone, easting, northing)
  const e = Math.round(easting)  % 100000
  const n = Math.round(northing) % 100000
  return `${zone}${latBand(lat)} ${sq} ${pad(e, 5)} ${pad(n, 5)}`
}

export function formatElevation(elevationM, unit) {
  if (elevationM === null || elevationM === undefined) return 'ELEV N/A'
  const value = unit === 'feet' ? elevationM * 3.28084 : elevationM
  return `${Math.round(value)}${unit === 'feet' ? 'FT' : 'M'}`
}
