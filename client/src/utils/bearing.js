// Bearing conversions — the ONE sanctioned place this math lives.
//
// Everything this app calls a bearing or heading — lat/lng math, unit.track,
// unit.heading, carrier.heading — lands in the same "true" reference frame:
//
//   - Flat lat/lng math (atan2(dE, dN)) gives real geographic true bearing.
//   - unit.track, in the normal (moving) case, is also geographic true —
//     Olympus derives it from consecutive lat/lng position samples, not from
//     the engine's raw heading (their own comment: "Track angles are wrong
//     because of weird reference systems, approximate it using latitude and
//     longitude differences"). Only falls back to raw engine heading
//     transiently — a contact's very first telemetry frame, or while
//     essentially stationary.
//   - unit.heading / carrier.heading are DCS's raw engine-frame heading, and
//     match what DCS itself displays as "True" heading almost exactly, even
//     at positions with several degrees of real grid convergence (verified
//     2026-07-27 against live DCS readouts on Caucasus and Persian Gulf).
//     DCS's own instruments don't correct engine heading for grid
//     convergence, so treat it as the same "true" frame as everything above.
//
// So there's one correction, everywhere: magnetic = true − declination. See
// utils/magvar.js for why grid convergence — while a real, computable
// geometric quantity for DCS's per-theatre Transverse Mercator projection —
// isn't part of that correction: DCS itself doesn't apply it, so matching
// what a pilot/controller actually sees means not adding it either.
//
// Use these functions; don't write atan2(dE, dN) or bare `- declination`
// inline at a new call site.

const NM_PER_DEG_LAT = 60

/**
 * True bearing + range between two lat/lng points, via flat-earth
 * approximation (fine at ATC/intercept scope ranges). Returns degrees
 * [0, 360) and nautical miles. Caller still owns converting to magnetic via
 * toMagneticFromTrue().
 */
export function trueBearingRangeNm(fromLat, fromLng, toLat, toLng) {
  const refLat      = (fromLat + toLat) / 2
  const nmPerDegLng = NM_PER_DEG_LAT * Math.cos(refLat * Math.PI / 180)
  const dN          = (toLat - fromLat) * NM_PER_DEG_LAT
  const dE          = (toLng - fromLng) * nmPerDegLng
  const trueBearingDeg = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360
  const rangeNm         = Math.hypot(dN, dE)
  return { trueBearingDeg, rangeNm }
}

/**
 * Inverse of trueBearingRangeNm — destination lat/lng from a start point plus
 * a true bearing (degrees) and range (nm), via the same flat-earth
 * approximation. refLat uses the start point rather than the fwd function's
 * start/end average since the caller doesn't know the endpoint yet; fine at
 * the short ranges (well under 1nm) this is meant for.
 */
export function destinationPoint(fromLat, fromLng, trueBearingDeg, rangeNm) {
  const bearingRad  = trueBearingDeg * Math.PI / 180
  const dN          = rangeNm * Math.cos(bearingRad)
  const dE          = rangeNm * Math.sin(bearingRad)
  const nmPerDegLng = NM_PER_DEG_LAT * Math.cos(fromLat * Math.PI / 180)
  return {
    lat: fromLat + dN / NM_PER_DEG_LAT,
    lng: fromLng + dE / nmPerDegLng,
  }
}

/** True → magnetic. Use for lat/lng-derived bearings, unit.track, and unit.heading/carrier.heading alike. */
export function toMagneticFromTrue(trueDeg, declinationDeg) {
  return (trueDeg - declinationDeg + 360) % 360
}

/** Magnetic → true. Inverse — for converting a user-typed/published magnetic bearing into true for internal storage/comparison. */
export function toTrueFromMagnetic(magDeg, declinationDeg) {
  return (magDeg + declinationDeg + 360) % 360
}
