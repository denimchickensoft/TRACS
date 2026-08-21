/**
 * .clear + click's hit-test — finds the visible custom-drawing layer whose
 * nearest EDGE (never a filled polygon's interior — clicking deep inside a
 * big circle away from its outline does not match it) is within
 * HIT_RADIUS_PX of the click, in screen pixels so it feels the same at any
 * zoom level. Point/MultiPoint features (.text included) hit-test as a
 * small radius around the point itself, since they have no edge.
 */

import { latLngToCanvas } from '../../../utils/projection.js'

const HIT_RADIUS_PX = 8

function pointToSegmentDistPx(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - ax, py - ay)
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function ringMinDistPx(view, ring, px, py) {
  const pts = ring.map(([lng, lat]) => latLngToCanvas(lat, lng, view))
  let best = Infinity
  for (let i = 0; i < pts.length - 1; i++) {
    best = Math.min(best, pointToSegmentDistPx(px, py, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y))
  }
  return best
}

function pointDistPx(view, [lng, lat], px, py) {
  const { x, y } = latLngToCanvas(lat, lng, view)
  return Math.hypot(px - x, py - y)
}

function featureMinDistPx(view, feature, px, py) {
  const g = feature.geometry
  switch (g.type) {
    case 'Point':
      return pointDistPx(view, g.coordinates, px, py)
    case 'MultiPoint':
      return Math.min(...g.coordinates.map(c => pointDistPx(view, c, px, py)))
    case 'LineString':
      return ringMinDistPx(view, g.coordinates, px, py)
    case 'MultiLineString':
      return Math.min(...g.coordinates.map(line => ringMinDistPx(view, line, px, py)))
    case 'Polygon':
      return Math.min(...g.coordinates.map(ring => ringMinDistPx(view, ring, px, py)))
    case 'MultiPolygon':
      return Math.min(...g.coordinates.flat().map(ring => ringMinDistPx(view, ring, px, py)))
    default:
      return Infinity
  }
}

// Returns the closest qualifying layer, or null if nothing's within range.
export function hitTestDrawingLayer(view, layers, px, py) {
  let bestLayer = null, bestDist = HIT_RADIUS_PX
  for (const layer of layers) {
    if (!layer.visible) continue
    for (const f of layer.features) {
      const d = featureMinDistPx(view, f, px, py)
      if (d < bestDist) { bestDist = d; bestLayer = layer }
    }
  }
  return bestLayer
}
