/**
 * Lat/lng ↔ canvas pixel projection.
 *
 * True Transverse Mercator (matching DCS's own per-theatre grid exactly —
 * see utils/transverseMercator.js and /projection_params.json), so contact
 * placement has no positional drift at range the way a flat equirectangular
 * approximation would. Grid north (the TM northing axis) is "up" before
 * rotation; when view.magvar is set (degrees East — IGRF declination plus
 * theatre grid convergence, see utils/magvar.js), the display is rotated so
 * magnetic north appears at the top of the screen instead.
 *
 * Theatres missing full TM params in projection_params.json (e.g.
 * Afghanistan) fall back to the previous flat equirectangular approximation,
 * logged once per theatre.
 *
 * view: { centerLat, centerLng, pixelsPerNm, width, height, magvar?, theatre? }
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

function rotate(nmEast, nmNorth, magvar) {
  const rad = magvar * Math.PI / 180
  return {
    rE: nmEast * Math.cos(rad) - nmNorth * Math.sin(rad),
    rN: nmEast * Math.sin(rad) + nmNorth * Math.cos(rad),
  }
}

function unrotate(rE, rN, magvar) {
  const rad = magvar * Math.PI / 180
  return {
    nmEast:  rE * Math.cos(rad) + rN * Math.sin(rad),
    nmNorth: -rE * Math.sin(rad) + rN * Math.cos(rad),
  }
}

export function latLngToCanvas(lat, lng, view) {
  const { centerLat, centerLng, pixelsPerNm, width, height, magvar = 0, theatre } = view
  const params = tmParamsFor(theatre)

  let nmEast, nmNorth
  if (params) {
    const p0 = tmForward(centerLat, centerLng, params)
    const p1 = tmForward(lat, lng, params)
    nmEast  = (p1.easting  - p0.easting)  / M_PER_NM
    nmNorth = (p1.northing - p0.northing) / M_PER_NM
  } else {
    const nmPerDegreeLng = NM_PER_DEGREE_LAT * Math.cos(centerLat * Math.PI / 180)
    nmNorth = (lat - centerLat) * NM_PER_DEGREE_LAT
    nmEast  = (lng - centerLng) * nmPerDegreeLng
  }

  // Rotate counterclockwise by magvar so magnetic north sits at screen top.
  const { rE, rN } = rotate(nmEast, nmNorth, magvar)

  return {
    x: width  / 2 + rE * pixelsPerNm,
    y: height / 2 - rN * pixelsPerNm,
  }
}

export function canvasToLatLng(x, y, view) {
  const { centerLat, centerLng, pixelsPerNm, width, height, magvar = 0, theatre } = view
  const params = tmParamsFor(theatre)

  const rE = (x - width  / 2) / pixelsPerNm
  const rN = (height / 2 - y) / pixelsPerNm

  // Inverse: clockwise rotation by magvar
  const { nmEast, nmNorth } = unrotate(rE, rN, magvar)

  if (params) {
    const p0 = tmForward(centerLat, centerLng, params)
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
