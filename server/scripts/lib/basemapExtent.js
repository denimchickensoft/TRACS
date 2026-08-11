'use strict'

// basemap's own wide clip bbox, extracted from buildAbmBasemap.js
// (2026-08-11) so a second caller (buildOsmLand.js) can pre-clip OSM land
// polygons to the exact same reach the basemap layer itself uses, without
// duplicating (and risking drifting out of sync with) this math.
//
// MAX_RANGE_NM/ASPECT_TARGET must match AbmScope.jsx's RANGE_MAX and the
// worst-case monitor aspect ratio — see buildAbmBasemap.js's own basemap
// section comment for the full sizing rationale.

const MAX_RANGE_NM  = 600
const ASPECT_TARGET = 2.33
const DEG_PAD       = 1.1
const BM_MAX_DIM    = 4800 // must match buildAbmBasemap.js's own BM_MAX_DIM — moved here
                            // (2026-08-11) so buildOsmLand.js can derive the same implied
                            // render resolution for its simplification tolerance instead of
                            // guessing a number that could drift out of sync.

// basemap's own render resolution (nm/pixel) — a flat land/sea silhouette
// viewed at up to MAX_RANGE_NM doesn't need anywhere near roads/rivers'
// ~20m simplification tolerance (tuned to a much tighter ~150m/px render
// scale); land polygon simplification for this layer should be tuned to
// basemap's own, much coarser resolution instead.
function bmNmPerPixel() {
  return (2 * MAX_RANGE_NM * ASPECT_TARGET) / BM_MAX_DIM
}

// bbox: theatre's [lonMin, latMin, lonMax, latMax] (theatres.json). Returns
// { originLat, originLng, bbox: bmClipBbox } — origin is the theatre bbox's
// own center, same point buildAbmBasemap.js's TM origin is anchored on.
function computeBmClipBbox(bbox) {
  const [lonMin, latMin, lonMax, latMax] = bbox
  const originLat = (latMin + latMax) / 2
  const originLng = (lonMin + lonMax) / 2

  const bmHalfExtentNm = MAX_RANGE_NM * ASPECT_TARGET
  const latPadDeg = (bmHalfExtentNm / 60) * DEG_PAD
  const cosLat    = Math.max(0.2, Math.cos(originLat * Math.PI / 180))
  const lonPadDeg = (bmHalfExtentNm / 60 / cosLat) * DEG_PAD

  return {
    originLat, originLng,
    bbox: [originLng - lonPadDeg, originLat - latPadDeg, originLng + lonPadDeg, originLat + latPadDeg],
  }
}

module.exports = { MAX_RANGE_NM, ASPECT_TARGET, DEG_PAD, BM_MAX_DIM, bmNmPerPixel, computeBmClipBbox }
