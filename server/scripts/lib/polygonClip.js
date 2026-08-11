'use strict'

// Shared 2D polygon clipping primitives, extracted from buildGeoData.js
// (2026-08-11) so a second caller (buildAbmBasemap.js's land-fill layer)
// can clip Natural Earth land polygons to its own, much wider bbox without
// duplicating this logic. Pure geometry — no lon/lat assumptions baked in,
// works equally on projected nm-space points if a caller ever needs that.

function bboxOf(coords) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of coords) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return [minX, minY, maxX, maxY]
}

function bboxIntersects(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
}

// Standard Sutherland–Hodgman against a convex rectangle, run once per axis.
function clipEdge(points, inside, intersect) {
  if (!points.length) return []
  const out = []
  const n = points.length
  for (let i = 0; i < n; i++) {
    const curr = points[i]
    const prev = points[(i - 1 + n) % n]
    const currIn = inside(curr)
    if (currIn !== inside(prev)) out.push(intersect(prev, curr))
    if (currIn) out.push(curr)
  }
  return out
}

function clipRingToBbox(ring, bbox) {
  const [xmin, ymin, xmax, ymax] = bbox
  let pts = ring
  pts = clipEdge(pts, p => p[0] >= xmin, (a, b) => [xmin, a[1] + (xmin - a[0]) * (b[1] - a[1]) / (b[0] - a[0])])
  pts = clipEdge(pts, p => p[0] <= xmax, (a, b) => [xmax, a[1] + (xmax - a[0]) * (b[1] - a[1]) / (b[0] - a[0])])
  pts = clipEdge(pts, p => p[1] >= ymin, (a, b) => [a[0] + (ymin - a[1]) * (b[0] - a[0]) / (b[1] - a[1]), ymin])
  pts = clipEdge(pts, p => p[1] <= ymax, (a, b) => [a[0] + (ymax - a[1]) * (b[0] - a[0]) / (b[1] - a[1]), ymax])
  return pts
}

// Every ring (outer boundaries and holes alike) clipped independently and
// handed back flat — fillPolygonEvenOdd doesn't need holes paired with their
// own outer ring, just the full set together in one call, since even-odd
// parity across disjoint real-world landmasses/holes works out the same
// either way (see 2026-08-03 discussion). `bbox` must already include
// whatever padding the caller wants — this function does not add any.
function extractLandRings(features, bbox) {
  const out = []
  for (const feat of features) {
    const geom = feat.geometry
    if (!geom) continue
    const polys = geom.type === 'Polygon'      ? [geom.coordinates]
                : geom.type === 'MultiPolygon' ? geom.coordinates
                : []
    for (const rings of polys) {
      for (const ring of rings) {
        const ringBbox = bboxOf(ring)
        if (!bboxIntersects(ringBbox, bbox)) continue
        const clipped = clipRingToBbox(ring, bbox)
        if (clipped.length >= 3) out.push(clipped)
      }
    }
  }
  return out
}

module.exports = { bboxOf, bboxIntersects, clipEdge, clipRingToBbox, extractLandRings }
