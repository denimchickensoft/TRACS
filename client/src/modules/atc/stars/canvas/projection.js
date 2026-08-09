/**
 * Lat/lng ↔ canvas pixel projection.
 *
 * True Transverse Mercator (matching DCS's own per-theatre grid exactly —
 * see utils/transverseMercator.js and /projection_params.json), so contact
 * placement has no positional drift at range the way a flat equirectangular
 * approximation would. Grid north (the TM northing axis) is "up" before
 * rotation; when view.declinationDeg is set (IGRF declination — see
 * utils/magvar.js), the display is rotated so magnetic north appears at the
 * top of the screen instead. Declination only, deliberately not combined
 * with grid convergence — DCS's own heading readouts don't apply that
 * correction either, so matching DCS means not adding it here.
 *
 * Theatres missing full TM params in projection_params.json (e.g.
 * Afghanistan) fall back to the previous flat equirectangular approximation,
 * logged once per theatre.
 *
 * view: { centerLat, centerLng, pixelsPerNm, width, height, declinationDeg?, theatre? }
 */

import { tmForward, tmInverse } from '../../../../utils/transverseMercator.js'
import { getProjectionParams } from '../../../../utils/magvar.js'

const NM_PER_DEGREE_LAT = 60
const M_PER_NM = 1852

const _warnedTheatres = new Set()

function tmParamsFor(theatre) {
  if (!theatre) return null
  const params = getProjectionParams(theatre)
  if (!params && !_warnedTheatres.has(theatre)) {
    _warnedTheatres.add(theatre)
    console.warn(`projection.js: no TM params for theatre "${theatre}" — falling back to flat equirectangular approximation`)
  }
  return params
}

function rotate(nmEast, nmNorth, declinationDeg) {
  const rad = declinationDeg * Math.PI / 180
  return {
    rE: nmEast * Math.cos(rad) - nmNorth * Math.sin(rad),
    rN: nmEast * Math.sin(rad) + nmNorth * Math.cos(rad),
  }
}

function unrotate(rE, rN, declinationDeg) {
  const rad = declinationDeg * Math.PI / 180
  return {
    nmEast:  rE * Math.cos(rad) + rN * Math.sin(rad),
    nmNorth: -rE * Math.sin(rad) + rN * Math.cos(rad),
  }
}

// The view center's TM projection is identical for every point projected
// against a given view, but latLngToCanvas/canvasToLatLng get called once
// per vertex (thousands of times per redraw for relief/geo/maps layers).
// Cache the last one instead of recomputing it per vertex.
let _centerCache = { theatre: null, lat: null, lng: null, result: null }

function tmForwardCenter(centerLat, centerLng, theatre, params) {
  const c = _centerCache
  if (c.theatre === theatre && c.lat === centerLat && c.lng === centerLng) return c.result
  const result = tmForward(centerLat, centerLng, params)
  _centerCache = { theatre, lat: centerLat, lng: centerLng, result }
  return result
}

export function latLngToCanvas(lat, lng, view) {
  const { centerLat, centerLng, pixelsPerNm, width, height, declinationDeg = 0, theatre } = view
  const params = tmParamsFor(theatre)

  let nmEast, nmNorth
  if (params) {
    const p0 = tmForwardCenter(centerLat, centerLng, theatre, params)
    const p1 = tmForward(lat, lng, params)
    nmEast  = (p1.easting  - p0.easting)  / M_PER_NM
    nmNorth = (p1.northing - p0.northing) / M_PER_NM
  } else {
    const nmPerDegreeLng = NM_PER_DEGREE_LAT * Math.cos(centerLat * Math.PI / 180)
    nmNorth = (lat - centerLat) * NM_PER_DEGREE_LAT
    nmEast  = (lng - centerLng) * nmPerDegreeLng
  }

  // Rotate counterclockwise by declination so magnetic north sits at screen top.
  const { rE, rN } = rotate(nmEast, nmNorth, declinationDeg)

  return {
    x: width  / 2 + rE * pixelsPerNm,
    y: height / 2 - rN * pixelsPerNm,
  }
}

export function canvasToLatLng(x, y, view) {
  const { centerLat, centerLng, pixelsPerNm, width, height, declinationDeg = 0, theatre } = view
  const params = tmParamsFor(theatre)

  const rE = (x - width  / 2) / pixelsPerNm
  const rN = (height / 2 - y) / pixelsPerNm

  // Inverse: clockwise rotation by declination
  const { nmEast, nmNorth } = unrotate(rE, rN, declinationDeg)

  if (params) {
    const p0 = tmForwardCenter(centerLat, centerLng, theatre, params)
    const easting  = p0.easting  + nmEast  * M_PER_NM
    const northing = p0.northing + nmNorth * M_PER_NM
    const { lat, lng } = tmInverse(easting, northing, params)
    return { lat, lng }
  }

  const nmPerDegreeLng = NM_PER_DEGREE_LAT * Math.cos(centerLat * Math.PI / 180)
  return {
    lat: centerLat + nmNorth / NM_PER_DEGREE_LAT,
    lng: centerLng + nmEast  / nmPerDegreeLng,
  }
}

export function rangeToPixelsPerNm(rangeNm, width, height) {
  return (Math.min(width, height) / 2) / rangeNm
}

// Per-ring projected-point cache for static geometry (relief bands,
// coastlines, boundaries — arrays of [lon, lat] pairs that never change once
// loaded). The big combined map-layer effect redraws everything on its one
// shared canvas whenever ANY of its many dependencies change (e.g. toggling
// an unrelated overlay's visibility), not just when the view actually moves
// — so without this, static geometry gets fully re-projected on redraws
// that didn't touch it at all. Keyed by the ring array's own identity, so
// it's invalidated for free whenever the underlying data is reloaded/
// replaced; keyed by view signature so an actual pan/zoom/rotate still
// reprojects normally.
const _ringCache = new WeakMap()

function viewSignature(view) {
  return view.centerLat + ',' + view.centerLng + ',' + view.pixelsPerNm + ',' +
    view.width + ',' + view.height + ',' + (view.declinationDeg || 0) + ',' + view.theatre
}

export function projectRingCached(ring, view) {
  const sig = viewSignature(view)
  const cached = _ringCache.get(ring)
  if (cached && cached.sig === sig) return cached.points
  const points = ring.map(([lon, lat]) => latLngToCanvas(lat, lon, view))
  _ringCache.set(ring, { sig, points })
  return points
}
