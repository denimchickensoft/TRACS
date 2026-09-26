'use strict'

// Shared 2D polygon clipping primitives, used by buildGeoData.js and by
// buildAbmBasemap.js's land-fill layer (which clips Natural Earth land
// polygons to its own, much wider bbox). Pure geometry — no lon/lat assumptions baked in,
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
// either way. `bbox` must already include
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

// ── Open-polyline clip (Liang–Barsky) — for tracing a closed ring's boundary
// as a STROKE without the closed-shape clip above's side effect: clipRingToBbox
// necessarily produces a valid closed polygon, so wherever the source ring
// extends past the bbox it inserts new points running along the bbox's own
// rectangle edge to close the gap — invisible/correct for a fill (that edge
// just marks where the fill stops), but drawn as a fake straight "coastline"
// hugging the clip rectangle when the result is stroked instead (e.g.
// buildOsmLand.js's geo.json coastline merge). This clips each segment
// of the ring individually and, whenever a segment enters/exits the bbox,
// BREAKS the line there instead of closing it — real coastline in, real
// coastline out, with a genuine gap (not a fake edge) wherever it leaves the
// visible area. Returns an array of open polylines (>=2 points each), not a
// single closed ring — one ring can produce zero, one, or several disjoint
// pieces depending on how many times it crosses the bbox boundary.
//
// Minor known imperfection: a ring that starts/ends (index 0 / index n-1,
// equal per GeoJSON convention) partway through an in-bbox run gets that one
// run split into two pieces at the array's own start/end seam — an arbitrary
// storage artifact, not a real geographic feature, and harmless to stroke
// (no fake connecting line is drawn, just an unnecessary extra break in what
// would ideally be one continuous line). Not worth the extra complexity of
// merging across the wrap point.
function clipSegmentParams(x0, y0, x1, y1, bbox) {
  const [xmin, ymin, xmax, ymax] = bbox
  const dx = x1 - x0, dy = y1 - y0
  let t0 = 0, t1 = 1
  const edges = [
    [-dx, x0 - xmin],
    [ dx, xmax - x0],
    [-dy, y0 - ymin],
    [ dy, ymax - y0],
  ]
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null // parallel to this edge and entirely outside it
      continue
    }
    const r = q / p
    if (p < 0) {
      if (r > t1) return null
      if (r > t0) t0 = r
    } else {
      if (r < t0) return null
      if (r < t1) t1 = r
    }
  }
  return t0 <= t1 ? [t0, t1] : null
}

function clipRingToOpenPolylines(ring, bbox) {
  const out = []
  let current = null
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i]
    const [x1, y1] = ring[i + 1]
    const clip = clipSegmentParams(x0, y0, x1, y1, bbox)
    if (!clip) {
      if (current && current.length >= 2) out.push(current)
      current = null
      continue
    }
    const [t0, t1] = clip
    const p0 = t0 <= 0 ? [x0, y0] : [x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0]
    const p1 = t1 >= 1 ? [x1, y1] : [x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1]
    if (!current) current = [p0]
    current.push(p1)
    if (t1 < 1) {
      if (current.length >= 2) out.push(current)
      current = null
    }
  }
  if (current && current.length >= 2) out.push(current)
  return out
}

module.exports = { bboxOf, bboxIntersects, clipEdge, clipRingToBbox, extractLandRings, clipRingToOpenPolylines }
