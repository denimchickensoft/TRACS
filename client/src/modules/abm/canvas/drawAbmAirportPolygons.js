/**
 * Renders airport surface polygons (taxiway/runway pavement) theatre-wide,
 * unfiltered — unlike ASDE-X's drawAsdexSurface, which is scoped to one
 * facility and also clears the canvas + paints an opaque background (it owns
 * a dedicated canvas). ABM composites this into a shared multi-layer canvas
 * alongside geo/relief/airways/etc, so it only fills the polygons themselves.
 */

import { projectRingCached, screenBoundsOfBbox } from '../../../utils/projection.js'

// Lon/lat bbox per feature, over every vertex of every ring. The fetched
// GeoJSON carries no bbox of its own, and feature objects are stable for the
// lifetime of a theatre load, so it's computed once and keyed off the feature.
const _bboxCache = new WeakMap()

function featureBbox(feature) {
  let bbox = _bboxCache.get(feature)
  if (bbox) return bbox
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
  for (const ring of feature.geometry.coordinates) {
    for (const [lng, lat] of ring) {
      if (lng < minLon) minLon = lng
      if (lng > maxLon) maxLon = lng
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
    }
  }
  bbox = [minLon, minLat, maxLon, maxLat]
  _bboxCache.set(feature, bbox)
  return bbox
}

export function drawAbmAirportPolygons(ctx, view, features, visible, taxiwayColor = '#3a3a3a', runwayColor = '#5a5a5a') {
  if (!visible || !features?.length) return

  const { width, height } = view
  for (const feature of features) {
    // Whole-feature cull only — dropping individual rings would break holes.
    const { x0, x1, y0, y1 } = screenBoundsOfBbox(featureBbox(feature), view)
    if (x1 < -5 || x0 > width + 5 || y1 < -5 || y0 > height + 5) continue

    ctx.fillStyle = feature.properties.type === 'runway' ? runwayColor : taxiwayColor
    ctx.beginPath()
    for (const ring of feature.geometry.coordinates) {
      const points = projectRingCached(ring, view)
      for (let i = 0; i < points.length; i++) {
        const { x, y } = points[i]
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.closePath()
    }
    ctx.fill()
  }
}
