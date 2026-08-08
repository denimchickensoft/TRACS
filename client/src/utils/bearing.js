// Bearing conversions — the ONE sanctioned place this math lives.
//
// Everything this app calls a bearing or heading — lat/lng math, unit.track,
// unit.heading, carrier.heading — lands in the same "true" reference frame:
//
//   - Flat lat/lng math (atan2(dE, dN)) gives real geographic true bearing.
//   - unit.track is geographic true by construction — but as of 2026-08-xx
//     TRACS computes it itself (store/units.js's applyDelta, from consecutive
//     real position samples via trueBearingRangeNm below) rather than trusting
//     Olympus's own field. Olympus's source claims the same derivation
//     ("Track angles are wrong because of weird reference systems,
//     approximate it using latitude and longitude differences"), but live
//     testing across two theatres found it empirically sitting at raw grid
//     heading instead — consistently, not just transiently on a first frame
//     or while stationary, which is what its own documented fallback would
//     predict. Unset on a unit's very first sample (no previous position to
//     derive from yet); every consumer already null-guards this.
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
//
// ── True-frame vs. grid-frame: which one does a bearing need? ────────────
// Everything above is about *headings/tracks a unit already has*. A second,
// separate case is computing a bearing *between two independently-resolved
// lat/lng positions* — an RBL, a BRAA, a bullseye readout, a PICTURE sector
// boundary. The projection.js canvas is oriented to **grid** north +
// declination (it projects into the theatre's real TM grid, then rotates by
// declination only — see projection.js's own header). trueBearingRangeNm/
// destinationPoint below are real-geographic-true-referenced, which only
// equals grid north at a theatre's central meridian; everywhere else they
// disagree by the local grid convergence angle (confirmed empirically:
// Bodø ~6°, Severomorsk-3 ~12° on Kola, Tbilisi ~8° on Caucasus). Use
// gridBearingRangeNm/gridDestinationPoint (below) instead of these two
// whenever the result needs to match the canvas or a DCS-displayed value —
// i.e. almost every position-to-position bearing in the app. Reserve
// trueBearingRangeNm/destinationPoint for cases genuinely about real
// geographic geometry (e.g. Par.jsx's runway corridor, which already adds
// real convergence on top via utils/magvar.js's theatreConvergence()).

import { tmForward, tmInverse } from './transverseMercator.js'
import { getProjectionParams }  from './magvar.js'

const NM_PER_DEG_LAT = 60
const M_PER_NM        = 1852

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

/**
 * Local tangent-plane (east, north) NM offset of (toLat,toLng) from
 * (fromLat,fromLng), scaling longitude by fromLat alone — the exact inverse
 * of destinationPoint (which projects an east/north offset the same way),
 * so offset → destinationPoint round-trips bit-for-bit. Deliberately NOT
 * the same reference trueBearingRangeNm uses (that one averages both
 * endpoints' latitudes — a better approximation over long distances, but
 * not destinationPoint's exact inverse). Use this one specifically when a
 * value needs to survive a decompose → reconstruct → decompose-again round
 * trip without drifting (e.g. .rect's live free-draw snapping, where the
 * snapped point gets independently re-decomposed by drawShapes.js's
 * buildRectFeature).
 */
export function localOffsetNm(fromLat, fromLng, toLat, toLng) {
  const nmPerDegLng = NM_PER_DEG_LAT * Math.cos(fromLat * Math.PI / 180)
  return {
    eastNm:  (toLng - fromLng) * nmPerDegLng,
    northNm: (toLat - fromLat) * NM_PER_DEG_LAT,
  }
}

/**
 * Bearing + range between two lat/lng points in the theatre's own TM grid
 * plane — matches canvas orientation (grid north + declination) and DCS's
 * own heading/track display convention. Use this, not trueBearingRangeNm,
 * for any bearing between two independently-resolved positions meant to
 * match what's displayed on the scope or in DCS (RBL, BRAA, bullseye,
 * PICTURE sectors). Falls back to trueBearingRangeNm's flat approximation
 * for theatres without TM params (Afghanistan, Iraq, MarianasWWII) — same
 * fallback projection.js uses for canvas placement on those theatres.
 */
export function gridBearingRangeNm(fromLat, fromLng, toLat, toLng, theatre) {
  const params = theatre ? getProjectionParams(theatre) : null
  if (!params) {
    const { trueBearingDeg, rangeNm } = trueBearingRangeNm(fromLat, fromLng, toLat, toLng)
    return { gridBearingDeg: trueBearingDeg, rangeNm }
  }

  const p0 = tmForward(fromLat, fromLng, params)
  const p1 = tmForward(toLat, toLng, params)
  const dE = p1.easting  - p0.easting
  const dN = p1.northing - p0.northing
  const gridBearingDeg = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360
  const rangeNm         = Math.hypot(dE, dN) / M_PER_NM
  return { gridBearingDeg, rangeNm }
}

/**
 * Inverse of gridBearingRangeNm — destination lat/lng from a start point plus
 * a grid-frame bearing (degrees) and range (nm). Use this, not
 * destinationPoint, when the input bearing is grid heading/course-derived
 * (e.g. course + declinationDeg, or a raw unit/carrier heading) rather than
 * a real geodesic true bearing. Falls back to destinationPoint's flat
 * approximation for theatres without TM params.
 */
export function gridDestinationPoint(fromLat, fromLng, gridBearingDeg, rangeNm, theatre) {
  const params = theatre ? getProjectionParams(theatre) : null
  if (!params) return destinationPoint(fromLat, fromLng, gridBearingDeg, rangeNm)

  const p0     = tmForward(fromLat, fromLng, params)
  const rad    = gridBearingDeg * Math.PI / 180
  const rangeM = rangeNm * M_PER_NM
  const easting  = p0.easting  + rangeM * Math.sin(rad)
  const northing = p0.northing + rangeM * Math.cos(rad)
  return tmInverse(easting, northing, params)
}

/** True → magnetic. Use for lat/lng-derived bearings, unit.track, and unit.heading/carrier.heading alike. */
export function toMagneticFromTrue(trueDeg, declinationDeg) {
  return (trueDeg - declinationDeg + 360) % 360
}

/** Magnetic → true. Inverse — for converting a user-typed/published magnetic bearing into true for internal storage/comparison. */
export function toTrueFromMagnetic(magDeg, declinationDeg) {
  return (magDeg + declinationDeg + 360) % 360
}
