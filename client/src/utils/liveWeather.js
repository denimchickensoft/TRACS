// Live weather from the DCS exporter (the session store's weather: the
// mission's weather table, its cloud preset, live fog and per-airfield
// samples), for scopes that show an altimeter, wind or METAR from it. Other
// sources send no weather.

import { toMagneticFromTrue } from './bearing.js'
import { MS_TO_KT } from './units.js'

const HPA_TO_INHG = 0.0295299830714

// The airfield entry for a carrier (by unit id) or an airfield (by its DCS
// name, the airbase callsign), or null.
export function findAirfieldWeather(weather, { callsign, unitId } = {}) {
  const airfields = Object.values(weather?.airfields ?? {})
  if (unitId != null) {
    const match = airfields.find((a) => a.unitId != null && a.unitId === Number(unitId))
    if (match) return match
  }
  if (callsign) return airfields.find((a) => a.callsign === callsign) ?? null
  return null
}

// The DCS airbase name for a real ICAO code in this theatre, from
// icaoMapping.json's theatre -> DCS name -> ICAO table, or null.
export function icaoToAirbaseName(icaoMapping, theatre, icao) {
  if (!theatre || !icao) return null
  const names = icaoMapping?.[theatre.toLowerCase()] ?? {}
  const want = icao.toUpperCase()
  return Object.keys(names).find((name) => String(names[name]).toUpperCase() === want) ?? null
}

// STARS altimeter text, in the forms .ALTIM accepts: inHg ('29.92'), or
// whole hPa ('1013') for a metric scope.
export function starsAltimeter(qnhHpa, metric) {
  return metric ? String(Math.round(qnhHpa)) : (qnhHpa * HPA_TO_INHG).toFixed(2)
}

// CATCC status board QNH: inHg x 100 as four digits ('2992'), as mission
// import writes it.
export function catccQnh(qnhHpa) {
  return String(Math.round(qnhHpa * HPA_TO_INHG * 100)).padStart(4, '0')
}

const pad = (n, len) => String(n).padStart(len, '0')

// Controller wind text, 'DDDSS' ('36005'): magnetic direction the wind
// blows from to the nearest 10 degrees (360 for north), speed in knots;
// '00000' when calm. '' without a wind.
export function formatWind(wind, declinationDeg = 0) {
  if (!wind || typeof wind.speedMs !== 'number' || typeof wind.fromDeg !== 'number') return ''
  const kt = Math.round(wind.speedMs * MS_TO_KT)
  if (kt === 0) return '00000'
  let dir = Math.round(toMagneticFromTrue(wind.fromDeg, declinationDeg) / 10) * 10
  if (dir === 0) dir = 360
  return `${pad(dir, 3)}${pad(kt, 2)}`
}

// A typed wind ('270/6', '274/06', '27406') as 'DDDSS', or null if it
// isn't one: direction 0-360, rounded to the nearest 10 degrees like a live
// wind (360 for north, '00000' when calm), speed 0-199 kt.
export function normalizeWind(text) {
  const t = String(text ?? '').trim()
  const m = /^(\d{1,3})\/(\d{1,3})$/.exec(t) ?? /^(\d{3})(\d{2,3})$/.exec(t)
  if (!m) return null
  const kt = Number(m[2])
  if (Number(m[1]) > 360 || kt > 199) return null
  if (kt === 0) return '00000'
  let dir = Math.round(Number(m[1]) / 10) * 10
  if (dir === 0) dir = 360
  return `${pad(dir, 3)}${pad(kt, 2)}`
}

// Headwind along the carrier's BRC in knots: its own speed plus the wind's
// component along the bow (negative for a tailwind). windText is the board's
// 'DDDSS' (magnetic, knots), brcDeg magnetic. null without a usable wind.
export function deckWindKt(windText, brcDeg, carrierKt) {
  const wind = normalizeWind(windText)
  if (!wind || typeof brcDeg !== 'number' || typeof carrierKt !== 'number') return null
  const dir = Number(wind.slice(0, 3))
  const kt = Number(wind.slice(3))
  return carrierKt + kt * Math.cos((dir - brcDeg) * Math.PI / 180)
}
