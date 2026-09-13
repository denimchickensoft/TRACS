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

// ICAO Item-15 route-string point: DDMM(N/S)DDDMM(E/W), whole minutes, no
// symbols/decimals (e.g. "4613N02000E"). Used as the fallback token for a
// route waypoint that doesn't name-match a real navdata fix (see
// utils/fixMatch.js) -- NOT a display format for cursor readouts, which use
// formatDMS/formatDDM above instead. Rounding to whole minutes introduces up
// to ~0.5-0.71 NM of error (worst case at low latitude, where a minute of
// longitude is closest to a minute of latitude); accepted for this use case.
export function formatIcaoRoutePoint(lat, lng) {
  const fmt = (value, degWidth, positiveLetter, negativeLetter) => {
    const letter = value >= 0 ? positiveLetter : negativeLetter
    const abs = Math.abs(value)
    let deg = Math.floor(abs)
    let min = Math.round((abs - deg) * 60)
    if (min === 60) { min = 0; deg += 1 } // rounding carry, e.g. 12°59.6' -> 13°00'
    return `${pad(deg, degWidth)}${pad(min, 2)}${letter}`
  }
  return `${fmt(lat, 2, 'N', 'S')}${fmt(lng, 3, 'E', 'W')}`
}

const ICAO_ROUTE_POINT_RE = /^(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])$/

// Inverse of formatIcaoRoutePoint -- lets a route resolver (e.g.
// modules/atc/stars/canvas/routeResolver.js) plot a fallback coordinate
// token at its real position instead of treating it as an unresolvable
// fix. Returns { lat, lng } or null if `token` isn't in this exact format.
export function parseIcaoRoutePoint(token) {
  const m = ICAO_ROUTE_POINT_RE.exec((token ?? '').trim().toUpperCase())
  if (!m) return null
  const [, latDeg, latMin, latLetter, lngDeg, lngMin, lngLetter] = m
  const lat = (Number(latDeg) + Number(latMin) / 60) * (latLetter === 'S' ? -1 : 1)
  const lng = (Number(lngDeg) + Number(lngMin) / 60) * (lngLetter === 'W' ? -1 : 1)
  if (lat > 90 || lng > 180) return null
  return { lat, lng }
}

export function formatElevation(elevationM, unit) {
  if (elevationM === null || elevationM === undefined) return 'ELEV N/A'
  const value = unit === 'feet' ? elevationM * 3.28084 : elevationM
  return `${Math.round(value)}${unit === 'feet' ? 'FT' : 'M'}`
}
