'use strict'

// Weather from the exporter hook's weather and airfieldWeather groups, in the
// units the rest of TRACS reads.
//
// The hook sends airfield samples raw: temperature in K, pressure in Pa at
// the field's surface, and wind as the air's velocity in m/s on DCS's map
// axes (x north, z east), 10 m above the surface and at the FD winds-aloft
// levels. Wind direction is reported the way a forecast does, as where the
// wind blows from, on the same raw engine north as unit headings (see
// exporterRelayClient.js's toTracsUnit).

const RAD_TO_DEG = 180 / Math.PI

// ISA sea-level temperature (K), lapse rate (K/m) and the barometric
// exponent g·M/(R·L).
const ISA_T0 = 288.15
const ISA_LAPSE = 0.0065
const BARO_EXP = 5.25588

// Surface pressure reduced to sea level through the standard atmosphere, the
// way an altimeter setting is: an altimeter set to it reads the field's
// elevation on the ground.
function qnhHpa(pressurePa, elevationM) {
  if (typeof pressurePa !== 'number' || !(pressurePa > 0)) return null
  const h = typeof elevationM === 'number' ? elevationM : 0
  return pressurePa / Math.pow(1 - ISA_LAPSE * h / ISA_T0, BARO_EXP) / 100
}

// To one decimal place, without the float noise of Math.round(x / 0.1) * 0.1.
const round1 = (x) => Math.round(x * 10) / 10

// { fromDeg, speedMs } for a wind velocity vector; fromDeg 0..359.
function toWind(wx, wz) {
  if (typeof wx !== 'number' || typeof wz !== 'number') return null
  const speedMs = Math.hypot(wx, wz)
  // + 360 then % 360 also turns atan2's -0 (due north) and a rounded 360 into 0.
  const fromDeg = (Math.round(Math.atan2(-wz, -wx) * RAD_TO_DEG) + 360) % 360
  return { fromDeg, speedMs: round1(speedMs) }
}

const toCelsius = (k) => (typeof k === 'number' ? round1(k - 273.15) : null)

// One airfieldWeather record -> { callsign, unitId?, latitude, longitude,
// elevationM, qnhHpa, tempC, wind, aloft: [{ ft, tempC, wind }] }. Returns
// null for an unusable record.
function toAirfieldWeather(rec) {
  if (!rec || typeof rec !== 'object' || typeof rec.callsign !== 'string') return null
  const qnh = qnhHpa(rec.p, rec.elevation)
  const out = {
    callsign: rec.callsign,
    latitude: rec.latitude,
    longitude: rec.longitude,
    elevationM: rec.elevation,
    qnhHpa: qnh === null ? null : round1(qnh),
    tempC: toCelsius(rec.t),
    wind: toWind(rec.wx, rec.wz),
    aloft: (Array.isArray(rec.aloft) ? rec.aloft : []).map((l) => ({
      ft: l.ft, tempC: toCelsius(l.t), wind: toWind(l.wx, l.wz),
    })),
  }
  if (rec.unitId != null) out.unitId = rec.unitId
  return out
}

// An airfieldWeather message's data -> airfields keyed as the hook keys them.
function toAirfieldsWeather(data) {
  const out = {}
  if (!data || typeof data !== 'object') return out
  for (const [key, rec] of Object.entries(data)) {
    const wx = toAirfieldWeather(rec)
    if (wx) out[key] = wx
  }
  return out
}

module.exports = { qnhHpa, toWind, toAirfieldWeather, toAirfieldsWeather }
