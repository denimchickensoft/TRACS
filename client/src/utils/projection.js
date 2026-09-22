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

import { tmForward, tmInverse } from './transverseMercator.js'
import { getProjectionParams, getProjectionParamsVersion } from './magvar.js'

const NM_PER_DEGREE_LAT = 60
const M_PER_NM = 1852

const _warnedTheatres = new Set()

function tmParamsFor(theatre) {
  if (!theatre) return null
  const params = getProjectionParams(theatre)
  if (!params && !_warnedTheatres.has(theatre)) {
    _warnedTheatres.add(theatre)
    console.warn(`projection.js: no TM params for theatre "${theatre}" - falling back to flat equirectangular approximation`)
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

// Screen-space bounding box of a [minLon, minLat, maxLon, maxLat] bbox,
// projecting all 4 corners (not just the SW/NE diagonal) — with a nonzero
// declinationDeg the view is rotated, and a rotated rectangle's true bounding
// box generally needs all 4 corners: the SW/NE diagonal alone under-estimates
// it (the error grows with the rotation angle and with how "chunky", vs.
// thin-sliver, the bbox is), which was silently culling on-screen geometry
// as fully off-screen once zoomed in enough that the true overlap was a
// small sliver of the shape's full extent. Mirrors drawMora.js's inline
// 4-corner check, which already got this right.
export function screenBoundsOfBbox(bbox, view) {
  const [minLon, minLat, maxLon, maxLat] = bbox
  const sw = latLngToCanvas(minLat, minLon, view)
  const se = latLngToCanvas(minLat, maxLon, view)
  const ne = latLngToCanvas(maxLat, maxLon, view)
  const nw = latLngToCanvas(maxLat, minLon, view)
  return {
    x0: Math.min(sw.x, se.x, ne.x, nw.x), x1: Math.max(sw.x, se.x, ne.x, nw.x),
    y0: Math.min(sw.y, se.y, ne.y, nw.y), y1: Math.max(sw.y, se.y, ne.y, nw.y),
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

// Two-tier cache for static geometry (relief bands, coastlines, boundaries —
// arrays of [lon, lat] pairs that never change once loaded). The big
// combined map-layer effect redraws everything on its one shared canvas
// whenever ANY of its many dependencies change (e.g. toggling an unrelated
// overlay's visibility), not just when the view actually moves — so without
// caching, static geometry gets fully re-projected on redraws that didn't
// touch it at all.
//
// Tier 1 (_ringCache): final SCREEN-SPACE points for a given view signature
// — a pure fast-path short-circuit for redraws where the view hasn't moved
// at all. Keyed by the ring array's own identity, so it's invalidated for
// free whenever the underlying data is reloaded/replaced (e.g. a theatre
// switch produces brand-new ring arrays).
//
// Tier 2 (_ringTmCache, 2026-08-11): each point's theatre-fixed TM
// easting/northing. Unlike the final screen point, this genuinely never
// changes for the life of a ring — pan/zoom/rotate don't move a coastline's
// real-world position, only the screen mapping of it — so it's cached
// permanently instead of being invalidated by every view change. A tier-1
// miss now only has to redo the CHEAP part on top of this (subtract the
// view center's own TM position — itself cached via tmForwardCenter —
// rotate by declination, scale to pixels), skipping tmForward's
// sinh/cosh/atanh/asinh entirely on repeat draws. This is what fixed the
// severe pan/zoom stutter on fjord/archipelago theatres (Kola, South
// Atlantic — tens of thousands of coastline rings, see the 2026-08-11 perf
// investigation): reprojecting every point through full TM math on every
// single pan frame was the dominant cost.
//
// Only applies to theatres with real TM params — the flat equirectangular
// fallback (no theatre in projection_params.json) computes its nm-offset
// directly from the view's own center, so it can't be cached this way and
// always falls through to the uncached per-point path below. In practice
// this fallback is unreachable as of 2026-08-11 (every theatre has real
// params) — kept only as a defensive path, not a currently-exercised one.
//
// getProjectionParamsVersion() in the signature closes a narrow startup
// race: projection_params.json loads asynchronously (App.jsx), so a ring
// could in principle draw once before params exist (using the fallback,
// tier-2 untouched) and then never redraw again if the view happens not to
// change afterward — leaving a stale tier-1 result cached under a
// pre-params signature forever. Bumping this version the moment params
// load changes the signature unconditionally, guaranteeing at least one
// more recompute — which will see real params and populate tier-2 correctly
// — regardless of whether the view itself ever moves again.
const _ringCache   = new WeakMap()
const _ringTmCache = new WeakMap()

function viewSignature(view) {
  return view.centerLat + ',' + view.centerLng + ',' + view.pixelsPerNm + ',' +
    view.width + ',' + view.height + ',' + (view.declinationDeg || 0) + ',' + view.theatre +
    ',' + getProjectionParamsVersion()
}

// Tier 2: ring's points in the theatre's own fixed TM plane (meters).
// theatre is part of the cache entry (not just the WeakMap key) as a cheap
// defensive check — ring arrays are always freshly created per theatre load
// (useGeoStore.loadForTheatre etc.), never mutated in place or reused
// across theatres, but this costs nothing to verify explicitly.
function projectRingToTm(ring, theatre, params) {
  const cached = _ringTmCache.get(ring)
  if (cached && cached.theatre === theatre) return cached.points
  const points = ring.map(([lon, lat]) => tmForward(lat, lon, params))
  _ringTmCache.set(ring, { theatre, points })
  return points
}

export function projectRingCached(ring, view) {
  const sig = viewSignature(view)
  const cached = _ringCache.get(ring)
  if (cached && cached.sig === sig) return cached.points

  const { centerLat, centerLng, pixelsPerNm, width, height, declinationDeg = 0, theatre } = view
  const params = tmParamsFor(theatre)

  let points
  if (params) {
    const tmPoints = projectRingToTm(ring, theatre, params)
    const p0 = tmForwardCenter(centerLat, centerLng, theatre, params)
    const rad = declinationDeg * Math.PI / 180
    const cosR = Math.cos(rad), sinR = Math.sin(rad)
    points = tmPoints.map((p1) => {
      const nmEast  = (p1.easting  - p0.easting)  / M_PER_NM
      const nmNorth = (p1.northing - p0.northing) / M_PER_NM
      const rE = nmEast * cosR - nmNorth * sinR
      const rN = nmEast * sinR + nmNorth * cosR
      return { x: width / 2 + rE * pixelsPerNm, y: height / 2 - rN * pixelsPerNm }
    })
  } else {
    // No TM params for this theatre (see comment above — not reachable in
    // practice today). Same flat-approximation math latLngToCanvas uses,
    // recomputed fully every call since it depends on the view's own
    // center, not just the point — tier 2 doesn't apply here.
    points = ring.map(([lon, lat]) => latLngToCanvas(lat, lon, view))
  }

  _ringCache.set(ring, { sig, points })
  return points
}
