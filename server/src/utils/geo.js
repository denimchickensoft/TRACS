'use strict'

// Shared geodetic math — real haversine distance/bearing plus earth-curvature-
// aware line-of-sight, for long-range (up to ~250nm) detection modeling.
// Extracted from tacviewDetection.js so missileDetection.js doesn't need its
// own duplicate copy of the same math.
//
// Deliberately NOT the same thing as client/src/utils/bearing.js — that one
// is a flat-earth approximation tuned for short ATC-scope ranges (RBL/BRAA/
// bullseye), and packages/geo-math (tracs-geo-math) is Transverse Mercator
// projection math for scope-plane rendering. Neither is a substitute for the
// real great-circle/curvature math long-range EWR/AWACS detection needs.

const elevation = require('../elevation')

const METERS_PER_NM = 1852
const EARTH_RADIUS_NM = 3440.065
// 4/3-effective-Earth-radius approximation for standard atmospheric
// refraction — the same correction real radar-horizon calculations use —
// rather than the true geometric radius.
const EFFECTIVE_EARTH_RADIUS_M = 6371000 * (4 / 3)
const NM_PER_DEG_LAT = 60

function toRad(deg) {
  return (deg * Math.PI) / 180
}

function toDeg(rad) {
  return (rad * 180) / Math.PI
}

function distanceNm(a, b) {
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)))
}

// True initial bearing from a to b, in degrees [0, 360).
function bearingDeg(a, b) {
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const dLng = toRad(b.lng - a.lng)
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

// Smallest absolute difference between two compass angles, 0-180.
function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

// Cheap bounding-box reject before the real haversine/LOS work. Widened by
// 1/cos(lat) on longitude since a degree of longitude compresses toward the
// poles — erring toward not rejecting a valid pair costs a little extra
// compute; erring the other way would silently drop real detections.
function quickReject(a, b, maxRangeNm) {
  const maxDeltaLat = maxRangeNm / NM_PER_DEG_LAT
  if (Math.abs(a.lat - b.lat) > maxDeltaLat) return true
  const lngCompression = Math.max(Math.cos(toRad(a.lat)), 0.1)
  const maxDeltaLng = maxRangeNm / (NM_PER_DEG_LAT * lngCompression)
  return Math.abs(a.lng - b.lng) > maxDeltaLng
}

// Linear interpolation along the great-circle path (adequate for the short
// distances/sample counts here — not a proper geodesic intermediate-point
// formula, which isn't warranted for a baseline heuristic).
function interpolate(a, b, frac) {
  return { lat: a.lat + (b.lat - a.lat) * frac, lng: a.lng + (b.lng - a.lng) * frac }
}

// Returns true if terrain and earth curvature together don't obstruct a
// straight line between the two positions' altitudes, sampled at
// losSampleCount points along the path.
//
// The curvature term matters once ranges realistically reach 100-250nm
// (real EWR/SAM acquisitionRange data) — a naive flat-altitude interpolation
// overstates detectability at range, since the earth's surface curves away
// beneath a straight sightline. At each sample point the effective sightline
// altitude is reduced by the standard chord/arc curvature-drop formula
// (d1*d2)/(2*Re), using the 4/3-effective-Earth-radius approximation for
// atmospheric refraction.
function hasLineOfSight(from, to, losSampleCount) {
  const totalDistM = distanceNm(from, to) * METERS_PER_NM
  for (let i = 1; i < losSampleCount; i++) {
    const frac = i / losSampleCount
    const point = interpolate(from, to, frac)
    const expectedAlt = from.alt + (to.alt - from.alt) * frac
    const d1 = totalDistM * frac
    const d2 = totalDistM * (1 - frac)
    const curvatureDropM = (d1 * d2) / (2 * EFFECTIVE_EARTH_RADIUS_M)
    const terrain = elevation.getElevation(point.lat, point.lng)
    if (terrain !== null && terrain > expectedAlt - curvatureDropM) return false
  }
  return true
}

module.exports = {
  METERS_PER_NM, EARTH_RADIUS_NM, EFFECTIVE_EARTH_RADIUS_M, NM_PER_DEG_LAT,
  toRad, toDeg, distanceNm, bearingDeg, angleDiff, quickReject, interpolate, hasLineOfSight,
}
