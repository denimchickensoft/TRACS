// Geometry builders for the ABM DRAW drawer's typed/click drawing commands
// (.line/.rect/.circ/.poly/.sect/.race/.text, see AbmScope.jsx execCommand).
// Each builder returns a single normalized feature in the exact
// {geometry, properties, bbox, label} shape parseGeojson.js produces, so
// drawAbmCustomDrawings.js renders these with zero changes beyond the
// Point-label-rotation support added for .text.
//
// All lat/lng math goes through utils/bearing.js's destinationPoint/
// gridDestinationPoint — the one sanctioned place this app computes bearings
// and ranges — never bare trig at a call site here. Most shapes here
// (.rect/.circ/.poly/.race/.text) are frame-agnostic or deliberately
// real-true (see each builder's own comment); .sect is the one that must be
// grid-frame, to match what a controller clicks/types as a magnetic bearing.

import { destinationPoint, gridDestinationPoint, localOffsetNm } from './bearing.js'
import { computeBbox } from './parseGeojson.js'

function feature(geometry, properties = {}, label = null) {
  return { geometry, properties, bbox: computeBbox(geometry), label }
}

// Rotates a local (eNm, nNm) offset from origin by rotationDeg (clockwise,
// bearing convention) and projects it via destinationPoint.
function offsetPoint(origin, eNm, nNm, rotationDeg = 0) {
  const range = Math.hypot(eNm, nNm)
  if (range === 0) return { lat: origin.lat, lng: origin.lng }
  const brg = (Math.atan2(eNm, nNm) * 180 / Math.PI + 360) % 360
  return destinationPoint(origin.lat, origin.lng, brg + rotationDeg, range)
}

// Samples a semicircular (180°) arc around `center`, starting at
// `startBrg` and sweeping toward the turnDir side (R = clockwise/+,
// L = counter-clockwise/-). Returns [lng,lat] pairs, both endpoints
// included.
function turnArcPoints(center, startBrg, turnDir, radiusNm, steps = 18) {
  const sign = turnDir === 'L' ? -1 : 1
  const pts = []
  for (let i = 0; i <= steps; i++) {
    const brg = (startBrg + sign * (180 * i / steps) + 360) % 360
    const { lat, lng } = destinationPoint(center.lat, center.lng, brg, radiusNm)
    pts.push([lng, lat])
  }
  return pts
}

/** .line — straight segment between two points. */
export function buildLineFeature({ p1, p2 }) {
  const geometry = {
    type: 'LineString',
    coordinates: [[p1.lng, p1.lat], [p2.lng, p2.lat]],
  }
  return feature(geometry)
}

/**
 * .rect — axis-aligned-then-rotated rectangle. `anchor`/`opposite` are the
 * two diagonal corners before rotation; the rectangle is rotated about
 * `anchor` by rotationDeg (matches the click-driven "middle-click rotates
 * about the anchored corner" interaction).
 */
export function buildRectFeature({ anchor, opposite, rotationDeg = 0 }) {
  // localOffsetNm, not trueBearingRangeNm — this must be the exact inverse
  // of offsetPoint/destinationPoint's own fromLat-referenced projection, or
  // a snapped-to-whole-NM `opposite` (drawCommands.js's snapRectOpposite,
  // built the same way) decomposes back to a slightly different, no-longer-
  // round east/west offset (trueBearingRangeNm's average-of-both-endpoints
  // reference drifts from anchor's own reference as soon as dN != 0).
  const { eastNm: dE, northNm: dN } = localOffsetNm(anchor.lat, anchor.lng, opposite.lat, opposite.lng)
  const localCorners = [[0, 0], [dE, 0], [dE, dN], [0, dN]]
  const ring = localCorners.map(([e, n]) => {
    const { lat, lng } = offsetPoint(anchor, e, n, rotationDeg)
    return [lng, lat]
  })
  ring.push(ring[0])
  return feature({ type: 'Polygon', coordinates: [ring] })
}

/** .circ — geodesic circle, tessellated as a vertex-array polygon (persists
 * as real GeoJSON, unlike the screen-space ctx.arc range rings use). */
export function buildCircFeature({ center, radiusNm }) {
  const ring = []
  for (let brg = 0; brg < 360; brg += 5) {
    const { lat, lng } = destinationPoint(center.lat, center.lng, brg, radiusNm)
    ring.push([lng, lat])
  }
  ring.push(ring[0])
  return feature({ type: 'Polygon', coordinates: [ring] })
}

/**
 * .poly — freeform polygon from whatever vertices the controller clicked or
 * typed (fix identifiers and/or raw N20W040-style coordinates, resolved in
 * drawCommands.js) — no side count, no regularity requirement, just a
 * closed ring through whatever points it's given, closing between the last
 * and first.
 */
export function buildPolyFeature({ vertices }) {
  const ring = vertices.map(v => [v.lng, v.lat])
  ring.push(ring[0])
  return feature({ type: 'Polygon', coordinates: [ring] })
}

/**
 * .sect — pie-slice sector from startBrg to endBrg, clockwise. startBrg/
 * endBrg are grid-frame (drawCommands.js converts click-derived bearings via
 * gridBearingRangeNm, and typed input via toTrueFromMagnetic — both grid, see
 * utils/bearing.js), so this uses gridDestinationPoint, not destinationPoint,
 * to stay in the same frame.
 */
export function buildSectFeature({ center, startBrg, endBrg, radiusNm, theatre }) {
  const start = ((startBrg % 360) + 360) % 360
  let end = ((endBrg % 360) + 360) % 360
  if (end <= start) end += 360

  const ring = [[center.lng, center.lat]]
  for (let brg = start; brg < end; brg += 5) {
    const { lat, lng } = gridDestinationPoint(center.lat, center.lng, brg % 360, radiusNm, theatre)
    ring.push([lng, lat])
  }
  const endPoint = gridDestinationPoint(center.lat, center.lng, end % 360, radiusNm, theatre)
  ring.push([endPoint.lng, endPoint.lat])
  ring.push([center.lng, center.lat])
  return feature({ type: 'Polygon', coordinates: [ring] })
}

/**
 * .race — holding-pattern-style racetrack over `fix`. `radialDeg` is the
 * radial FROM the station (confirmed convention); the inbound course flown
 * over the fix is its reciprocal. `turnDir` ('L'|'R') picks which side the
 * 180° turns arc to. `legNm` is the straight-leg length; `turnRadiusNm` the
 * turn radius (defaults to 1 NM at the call site, not here).
 */
export function buildRaceFeature({ fix, radialDeg, turnDir = 'R', legNm, turnRadiusNm }) {
  const inboundCourseDeg  = ((radialDeg + 180) % 360 + 360) % 360
  const outboundCourseDeg = ((radialDeg % 360) + 360) % 360

  // Turn 1: at the fix, from inbound onto outbound course.
  const c1Brg = (inboundCourseDeg + (turnDir === 'L' ? -90 : 90) + 360) % 360
  const c1    = destinationPoint(fix.lat, fix.lng, c1Brg, turnRadiusNm)
  const e1    = destinationPoint(fix.lat, fix.lng, c1Brg, 2 * turnRadiusNm)

  // Outbound leg.
  const g = destinationPoint(e1.lat, e1.lng, outboundCourseDeg, legNm)

  // Turn 2: at the far end, from outbound back onto inbound course.
  const c2Brg = (outboundCourseDeg + (turnDir === 'L' ? -90 : 90) + 360) % 360
  const c2    = destinationPoint(g.lat, g.lng, c2Brg, turnRadiusNm)
  const e2    = destinationPoint(g.lat, g.lng, c2Brg, 2 * turnRadiusNm)

  const arc1 = turnArcPoints(c1, (c1Brg + 180) % 360, turnDir, turnRadiusNm) // fix -> e1
  const arc2 = turnArcPoints(c2, (c2Brg + 180) % 360, turnDir, turnRadiusNm) // g -> e2

  const ring = [
    [fix.lng, fix.lat],
    ...arc1,
    [g.lng, g.lat],
    ...arc2,
    [fix.lng, fix.lat],
  ]
  return feature({ type: 'Polygon', coordinates: [ring] })
}

/** .text — a labeled point; rotationDeg drives drawAbmCustomDrawings.js's
 * Point-label rotation. Unlike other shapes, the label IS the command's
 * payload (not the drawer row's name), so it's set directly here rather
 * than patched in by the store on rename. */
export function buildTextFeature({ anchor, text, rotationDeg = 0 }) {
  const geometry = { type: 'Point', coordinates: [anchor.lng, anchor.lat] }
  return feature(geometry, { title: text, labelRotationDeg: rotationDeg }, [text])
}
