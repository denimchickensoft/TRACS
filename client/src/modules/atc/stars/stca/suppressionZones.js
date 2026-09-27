import { M_TO_FT as METERS_TO_FEET, EARTH_RADIUS_NM } from '../../../../utils/units.js'
// Conflict-alert suppression corridors near final approach courses.
//
// Real STARS suppresses CA/MCI near the final approach course of any runway
// at an ICAO-tagged airport in the facility's internal airports list. TRACS
// has no such facility-config list, so this is rebuilt from the runway data
// STARS already loads for the position (useRunwaysStore().centerlines,
// radius-filtered per position type — see store/runways.js), restricted to
// airports with an ICAO id.
//
// No per-runway glideslope data exists anywhere in the app (confirmed —
// Par.jsx's PAR display just defaults to 3.0°/3.5°, user-editable, not
// looked up). This uses the same fixed 3.0° GS + 50ft TCH assumption
// Par.jsx defaults to for airfield approaches. The projection math below is
// the same range/lateral/vertical decomposition Par.jsx's
// projectOnApproach() already does — duplicated locally rather than
// imported, matching how Par.jsx itself duplicates this math rather than
// pulling from utils/bearing.js.

const D2R            = Math.PI / 180
const NM_TO_FEET     = 6076.115

const GS_ANGLE_DEG          = 3.0   // fixed assumption — no per-runway data exists
const TCH_FT                = 50    // standard threshold crossing height
const CORRIDOR_HALF_WIDTH_NM = 2    // 4 NM wide corridor
const MAX_RANGE_NM          = 30    // extends 30 NM from threshold
const CEILING_ABOVE_GS_FT   = 1500  // vertical ceiling above the glideslope

function distNm(lat1, lng1, lat2, lng2) {
  const R  = EARTH_RADIUS_NM
  const φ1 = lat1 * D2R, φ2 = lat2 * D2R
  const Δφ = (lat2 - lat1) * D2R, Δλ = (lng2 - lng1) * D2R
  const a  = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function bearingDeg(lat1, lng1, lat2, lng2) {
  const φ1 = lat1 * D2R, φ2 = lat2 * D2R, Δλ = (lng2 - lng1) * D2R
  const y  = Math.sin(Δλ) * Math.cos(φ2)
  const x  = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return ((Math.atan2(y, x) / D2R) + 360) % 360
}

/**
 * Build suppression zones from the facility's currently loaded runway
 * centerlines, restricted to ICAO-tagged airports.
 * @param {Array} centerlines  useRunwaysStore().centerlines
 * @returns {Array<{id, threshLat, threshLng, headingRad, elevFt}>}
 */
export function buildSuppressionZones(centerlines) {
  return (centerlines ?? [])
    .filter((c) => c.icao != null)
    .map((c) => ({
      id:         c.id,
      threshLat:  c.thresholdLat,
      threshLng:  c.thresholdLng,
      headingRad: c.headingRad,
      elevFt:     c.elevFt,
    }))
}

/**
 * True if `pos` ({lat, lng, alt}, alt in meters MSL) falls inside any
 * suppression corridor.
 */
export function isSuppressed(pos, zones) {
  if (!pos || !zones || zones.length === 0) return false
  const altFt = (pos.alt ?? 0) * METERS_TO_FEET

  for (const z of zones) {
    const dist = distNm(z.threshLat, z.threshLng, pos.lat, pos.lng)
    if (dist > MAX_RANGE_NM + 1) continue // cheap reject before trig below

    const trueHdgDeg = ((z.headingRad / D2R) % 360 + 360) % 360
    const outbound    = (trueHdgDeg + 180) % 360
    const brg         = bearingDeg(z.threshLat, z.threshLng, pos.lat, pos.lng)
    const off         = ((outbound - brg) + 540) % 360 - 180
    const offRad      = off * D2R
    const rangeFinal  = dist * Math.cos(offRad)
    const lateralDev  = dist * Math.sin(offRad)

    if (rangeFinal < 0 || rangeFinal > MAX_RANGE_NM) continue
    if (Math.abs(lateralDev) > CORRIDOR_HALF_WIDTH_NM) continue

    const gsAlt   = z.elevFt + rangeFinal * NM_TO_FEET * Math.tan(GS_ANGLE_DEG * D2R) + TCH_FT
    const ceiling = gsAlt + CEILING_ABOVE_GS_FT
    if (altFt < z.elevFt || altFt > ceiling) continue

    return true
  }
  return false
}
