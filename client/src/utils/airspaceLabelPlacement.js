// Shared airspace label geometry + collision-avoidance placement, extracted
// from drawMaps.js/drawAbmAirspace.js (2026-08-08) so STARS and ABM's
// airspace layers stop duplicating identical label logic.
//
// Pure geometry — callers measure text themselves (ctx.measureText, since
// STARS' font size depends on csMap and ABM's is fixed) and pass widths in;
// this module never touches a canvas, same convention as datablockPlacement.js.
//
// Sectored/overlapping airspace (e.g. stacked TMA sectors sharing one
// physical boundary) routinely produces multiple features whose label
// anchor lands on the same edge midpoint. Rather than skip the loser (the
// altitude-band info it carries is still useful), each candidate is tried
// at increasing distance from its anchor, stacking outward past whatever's
// already been placed, and scored by how many already-placed label boxes
// it still overlaps (SAT, since labels are rotated to their edge's angle —
// unlike datablocks' always-upright text). The least-bad candidate is kept
// even if it still collides — nothing is ever dropped.

import { latLngToCanvas } from './projection.js'

const STACK_ATTEMPTS = 4

// Placed-label lookup grid: checking a new candidate against every already-
// placed label is O(n²) in label count (each candidate does a full SAT test
// against all of them, up to STACK_ATTEMPTS times). Bucketing placed rects
// by their axis-aligned bounds into a uniform grid lets a candidate only be
// tested against labels that are actually nearby — same exact SAT result,
// just skips pairs that can't possibly overlap. Cell size doesn't affect
// correctness, only how many buckets a given rect touches.
const GRID_CELL_PX = 128

function rectAabb({ cx, cy, halfW, halfH, angle }) {
  const cosA = Math.abs(Math.cos(angle)), sinA = Math.abs(Math.sin(angle))
  const exX = halfW * cosA + halfH * sinA
  const exY = halfW * sinA + halfH * cosA
  return { minX: cx - exX, minY: cy - exY, maxX: cx + exX, maxY: cy + exY }
}

function createPlacedGrid(cellSize) {
  const cells = new Map()
  function keysFor({ minX, minY, maxX, maxY }) {
    const x0 = Math.floor(minX / cellSize), x1 = Math.floor(maxX / cellSize)
    const y0 = Math.floor(minY / cellSize), y1 = Math.floor(maxY / cellSize)
    const keys = []
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) keys.push(cx + ',' + cy)
    }
    return keys
  }
  return {
    insert(rect) {
      for (const key of keysFor(rectAabb(rect))) {
        let bucket = cells.get(key)
        if (!bucket) { bucket = []; cells.set(key, bucket) }
        bucket.push(rect)
      }
    },
    queryCandidates(rect) {
      const seen = new Set()
      const out = []
      for (const key of keysFor(rectAabb(rect))) {
        const bucket = cells.get(key)
        if (!bucket) continue
        for (const r of bucket) {
          if (!seen.has(r)) { seen.add(r); out.push(r) }
        }
      }
      return out
    },
  }
}

/**
 * @param {object[]} items  [{ feature, lines: string[], lineWidths: number[], fontSize: number, color: string, extra?: any }]
 * @param {object}   view   { centerLat, centerLng, pixelsPerNm, width, height, ... }
 * @returns {object[]} [{ feature, lines, x, y, angle, color, extra }] — one entry per item with valid on-screen geometry
 */
export function placeAirspaceLabels(items, view) {
  const { width, height } = view
  const results = []
  const grid = createPlacedGrid(GRID_CELL_PX)

  for (const item of items) {
    const anchor = computeAnchor(item, view)
    if (!anchor) continue
    if (anchor.cx < -50 || anchor.cx > width + 50 || anchor.cy < -50 || anchor.cy > height + 50) continue

    let best = null
    let bestCollisions = Infinity
    for (let k = 0; k < STACK_ATTEMPTS; k++) {
      const rect = candidateRect(anchor, k)
      const nearby = grid.queryCandidates(rect)
      let collisions = 0
      for (const p of nearby) if (rectsOverlap(rect, p)) collisions++
      if (collisions < bestCollisions) {
        bestCollisions = collisions
        best = rect
      }
      if (collisions === 0) break
    }

    grid.insert(best)
    results.push({
      feature: item.feature,
      lines:   item.lines,
      color:   item.color,
      extra:   item.extra,
      x: best.cx, y: best.cy, angle: best.angle,
    })
  }

  return results
}

// Anchor = base position/angle/push-direction for a label, before any
// collision-driven nudging. null when the feature has no usable edge/shape.
function computeAnchor(item, view) {
  const { feature, lines, lineWidths, fontSize } = item
  const lineH   = fontSize + 3
  const halfW   = Math.max(...lineWidths) / 2
  const cLon = (feature.bbox[0] + feature.bbox[2]) / 2
  const cLat = (feature.bbox[1] + feature.bbox[3]) / 2

  if (isCircular(feature.geometry, [cLon, cLat])) {
    const { x, y } = latLngToCanvas(cLat, cLon, view)
    const halfH = lineH * lines.length / 2
    return { cx: x, cy: y, angle: 0, normalX: 0, normalY: 1, baseDist: 0, halfW, halfH, lineH }
  }

  const minLenPx = lineWidths[0]
  const edge = findLabelEdge(feature.geometry, view, minLenPx)
  if (!edge) return null
  const { mx, my, angle } = edge

  const { x: cx, y: cy } = latLngToCanvas(cLat, cLon, view)
  const inwardY = -(cx - mx) * Math.sin(angle) + (cy - my) * Math.cos(angle)
  const sign    = Math.sign(inwardY || 1)
  const halfH   = fontSize / 2 + lineH * (lines.length - 1) / 2

  return {
    cx: mx, cy: my, angle,
    normalX: -sign * Math.sin(angle),
    normalY:  sign * Math.cos(angle),
    baseDist: halfH + 3,
    halfW, halfH, lineH,
  }
}

// Stack attempt k: push further along the anchor's normal by one block
// height (plus gap) per step, so each successive candidate clears the
// previous one by construction.
function candidateRect(anchor, k) {
  const dist = anchor.baseDist + k * (2 * anchor.halfH + 3)
  return {
    cx: anchor.cx + anchor.normalX * dist,
    cy: anchor.cy + anchor.normalY * dist,
    angle: anchor.angle,
    halfW: anchor.halfW,
    halfH: anchor.halfH,
  }
}

// SAT overlap test for two (possibly rotated) rectangles.
function rectsOverlap(a, b) {
  const cornersA = rectCorners(a)
  const cornersB = rectCorners(b)
  for (const axis of [...edgeNormals(cornersA), ...edgeNormals(cornersB)]) {
    const [minA, maxA] = projectOntoAxis(cornersA, axis)
    const [minB, maxB] = projectOntoAxis(cornersB, axis)
    if (maxA < minB || maxB < minA) return false
  }
  return true
}

function rectCorners({ cx, cy, halfW, halfH, angle }) {
  const cosA = Math.cos(angle), sinA = Math.sin(angle)
  return [[-halfW, -halfH], [halfW, -halfH], [halfW, halfH], [-halfW, halfH]].map(([lx, ly]) => ({
    x: cx + lx * cosA - ly * sinA,
    y: cy + lx * sinA + ly * cosA,
  }))
}

function edgeNormals(corners) {
  const axes = []
  for (let i = 0; i < 2; i++) {
    const p1 = corners[i], p2 = corners[i + 1]
    axes.push({ x: -(p2.y - p1.y), y: p2.x - p1.x })
  }
  return axes
}

function projectOntoAxis(corners, axis) {
  const dots = corners.map(p => p.x * axis.x + p.y * axis.y)
  return [Math.min(...dots), Math.max(...dots)]
}

// Coefficient of variation of vertex distances from centroid — low = circular.
function isCircular(geometry, centroid) {
  const [cLng, cLat] = centroid
  const cosLat = Math.cos(cLat * Math.PI / 180)
  const ring = geometry.type === 'Polygon'
    ? geometry.coordinates[0]
    : geometry.coordinates[0][0]
  const dists = ring.map(([lng, lat]) => {
    const dx = (lng - cLng) * cosLat
    const dy = lat - cLat
    return Math.sqrt(dx * dx + dy * dy)
  })
  const mean = dists.reduce((a, b) => a + b, 0) / dists.length
  if (mean === 0) return false
  const variance = dists.reduce((s, d) => s + (d - mean) ** 2, 0) / dists.length
  return Math.sqrt(variance) / mean < 0.05
}

// LNM two-pass longest near-straight run: try 5° tolerance then 30°.
// Returns null if no run meets minLenPx.
function findLabelEdge(geometry, view, minLenPx) {
  const polygons = geometry.type === 'Polygon'
    ? [geometry.coordinates]
    : geometry.coordinates

  let best = null
  for (const toleranceDeg of [5, 30]) {
    for (const poly of polygons) {
      const result = longestNearStraightRun(poly[0], view, toleranceDeg)
      if (result && (!best || result.len > best.len)) best = result
    }
    if (best && best.len >= minLenPx) break
  }
  return best && best.len >= minLenPx ? best : null
}

function longestNearStraightRun(ring, view, toleranceDeg) {
  const n = ring.length - 1  // closed ring: last vertex === first
  if (n < 2) return null

  const pts = []
  for (let i = 0; i < n; i++) {
    pts.push(latLngToCanvas(ring[i][1], ring[i][0], view))
  }

  const tol = toleranceDeg * Math.PI / 180

  const angles  = new Array(n)
  const lengths = new Array(n)
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const dx = pts[j].x - pts[i].x
    const dy = pts[j].y - pts[i].y
    angles[i]  = Math.atan2(dy, dx)
    lengths[i] = Math.hypot(dx, dy)
  }

  let bestLen = -1, bestStart = 0, bestEndNext = 1

  for (let i = 0; i < n; i++) {
    let runLen = lengths[i]
    let j = i
    for (let step = 1; step < n; step++) {
      const next = (j + 1) % n
      let diff = Math.abs(angles[next] - angles[i])
      if (diff > Math.PI) diff = 2 * Math.PI - diff
      if (diff > tol) break
      j = next
      runLen += lengths[j]
    }
    if (runLen > bestLen) {
      bestLen = runLen
      bestStart = i
      bestEndNext = (j + 1) % n
    }
  }

  const mx = (pts[bestStart].x + pts[bestEndNext].x) / 2
  const my = (pts[bestStart].y + pts[bestEndNext].y) / 2
  const dx = pts[bestEndNext].x - pts[bestStart].x
  const dy = pts[bestEndNext].y - pts[bestStart].y
  let angle = Math.atan2(dy, dx)
  if (angle >  Math.PI / 2) angle -= Math.PI
  if (angle < -Math.PI / 2) angle += Math.PI

  return { mx, my, angle, len: bestLen }
}
