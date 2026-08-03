/**
 * Renders airspace polygon boundaries theatre-wide for ABM. Unlike STARS'
 * drawMaps (client/src/modules/atc/stars/canvas/drawMaps.js), this takes flat,
 * unbucketed features straight from the server response — ABM has no
 * facility to envelope-bucket around and no DCB slots to assign, it just
 * toggles whole categories (.tma/.ctr/.asp/etc, see AbmScope's asVisible).
 *
 * `dedupe = false` strokes every feature's rings independently, so adjacent
 * regions each draw their own shared border rather than merging into one
 * traced outline. Flip `dedupe = true` to fall back to drawMaps' behavior —
 * collectEdges/edgeKey below are copied verbatim from drawMaps.js for that.
 *
 * `colors` is one palette's `{ [displayCategory]: { stroke, dash, ... } }` map
 * from airspace_colors.json (see store/abmAirspace.js — fetched independently
 * of useMapsStore's palette state, which is STARS-only). Falls back to
 * FALLBACK_COLOR/solid-line per-feature when a category has no entry. `dash`
 * is scaled by view.pixelsPerNm, same convention as drawMaps.js.
 *
 * `labelsVisible` (AbmScope's `.labels` toggle) draws each feature's
 * nameLabel/altLabel — see drawLabels() below. Labels only ever appear for
 * features already passing the visibleCategories filter above, so they
 * track the .tma/.classc/etc category toggles automatically.
 */

import { latLngToCanvas } from '../../atc/stars/canvas/projection.js'

const FALLBACK_COLOR = '#556677'

export function drawAbmAirspace(ctx, view, features, visibleCategories, brite = 80, dedupe = false, colors = null, labelsVisible = false) {
  if (!features?.length) return
  const alpha = Math.max(0, Math.min(1, brite / 100))
  if (alpha <= 0) return

  const visibleFeatures = features.filter(f =>
    visibleCategories[f.displayCategory] && bboxInView(f.bbox, view))
  if (!visibleFeatures.length) return

  ctx.globalAlpha = alpha
  ctx.lineWidth   = 1.0

  if (dedupe) {
    // Group by category first, same as drawMaps.js's per-category loop — edges
    // are only deduped within a category, so each keeps its own color/dash.
    const byCategory = new Map()
    for (const f of visibleFeatures) {
      if (!byCategory.has(f.displayCategory)) byCategory.set(f.displayCategory, [])
      byCategory.get(f.displayCategory).push(f)
    }
    for (const [category, feats] of byCategory) {
      ctx.strokeStyle = colors?.[category]?.stroke ?? FALLBACK_COLOR
      ctx.setLineDash((colors?.[category]?.dash ?? []).map(v => v * view.pixelsPerNm))
      const edgeMap = new Map()
      for (const f of feats) collectEdges(f, edgeMap)
      ctx.beginPath()
      for (const [p1, p2] of edgeMap.values()) {
        const a = latLngToCanvas(p1[1], p1[0], view)
        const b = latLngToCanvas(p2[1], p2[0], view)
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
      }
      ctx.stroke()
    }
  } else {
    for (const f of visibleFeatures) {
      ctx.strokeStyle = colors?.[f.displayCategory]?.stroke ?? FALLBACK_COLOR
      ctx.setLineDash((colors?.[f.displayCategory]?.dash ?? []).map(v => v * view.pixelsPerNm))
      strokeFeature(ctx, view, f)
    }
  }

  ctx.setLineDash([])
  ctx.globalAlpha = 1.0

  if (labelsVisible) drawLabels(ctx, view, visibleFeatures, colors, alpha)
}

// Renders each feature's nameLabel/altLabel (same fields STARS' drawMaps.js
// reads), placed at the polygon centroid for round features or along the
// longest near-straight edge otherwise. Deliberately not shared with
// drawMaps.js — that version sizes text off csMap/briteMapB (STARS' DCB
// knobs, which ABM has no equivalent of), so it's simpler here: fixed font
// size, same alpha as the geometry pass. `visibleFeatures` is already
// filtered to on-toggle categories, so labels inherit that for free.
function drawLabels(ctx, view, visibleFeatures, colors, alpha) {
  const { width, height } = view
  const fontSize = 9
  const lineH    = fontSize + 3
  ctx.font         = `${fontSize}px "Roboto Mono", monospace`
  ctx.textAlign    = 'center'
  ctx.textBaseline = 'middle'
  ctx.globalAlpha  = alpha

  for (const f of visibleFeatures) {
    const label1 = f.isParent ? (f.nameLabel ?? null) : null
    const label2 = f.altLabel ?? null
    if (!label1 && !label2) continue

    ctx.fillStyle = colors?.[f.displayCategory]?.stroke ?? FALLBACK_COLOR
    const lines = [label1, label2].filter(Boolean)
    const minLenPx = ctx.measureText(lines[0]).width

    const cLon = (f.bbox[0] + f.bbox[2]) / 2
    const cLat = (f.bbox[1] + f.bbox[3]) / 2

    if (isCircular(f.geometry, [cLon, cLat])) {
      const { x, y } = latLngToCanvas(cLat, cLon, view)
      if (x < -50 || x > width + 50 || y < -50 || y > height + 50) continue
      lines.forEach((line, idx) => {
        ctx.fillText(line, x, y + (idx - (lines.length - 1) / 2) * lineH)
      })
    } else {
      const edge = findLabelEdge(f.geometry, view, minLenPx)
      if (!edge) continue
      const { mx, my, angle } = edge
      if (mx < -50 || mx > width + 50 || my < -50 || my > height + 50) continue

      const { x: cx, y: cy } = latLngToCanvas(cLat, cLon, view)
      const inwardY   = -(cx - mx) * Math.sin(angle) + (cy - my) * Math.cos(angle)
      const halfBlock = fontSize / 2 + lineH * (lines.length - 1) / 2
      const baseOff   = Math.sign(inwardY || 1) * (halfBlock + 3)

      ctx.save()
      ctx.translate(mx, my)
      ctx.rotate(angle)
      lines.forEach((line, idx) => {
        ctx.fillText(line, 0, baseOff + (idx - (lines.length - 1) / 2) * lineH)
      })
      ctx.restore()
    }
  }

  ctx.globalAlpha = 1.0
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

// Strokes one feature's rings independently of every other feature.
function strokeFeature(ctx, view, feature) {
  const polygons = feature.geometry.type === 'Polygon'
    ? [feature.geometry.coordinates]
    : feature.geometry.coordinates

  ctx.beginPath()
  for (const poly of polygons) {
    for (const ring of poly) {
      for (let j = 0; j < ring.length; j++) {
        const [lng, lat] = ring[j]
        const { x, y } = latLngToCanvas(lat, lng, view)
        if (j === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
    }
  }
  ctx.stroke()
}

// Collect all edges from a feature into edgeMap, keyed canonically so that
// an edge shared between two adjacent polygons is stored only once.
function collectEdges(feature, edgeMap) {
  const polygons = feature.geometry.type === 'Polygon'
    ? [feature.geometry.coordinates]
    : feature.geometry.coordinates

  for (const poly of polygons) {
    const ring = poly[0]
    const n = ring.length - 1  // GeoJSON closed rings duplicate the first vertex at the end
    for (let j = 0; j < n; j++) {
      const p1 = ring[j]
      const p2 = ring[(j + 1) % n]
      const key = edgeKey(p1, p2)
      if (!edgeMap.has(key)) edgeMap.set(key, [p1, p2])
    }
  }
}

// Canonical edge key: always orders the two endpoints the same way regardless
// of which polygon contributed the edge and in which direction.
function edgeKey(p1, p2) {
  const [lng1, lat1] = p1
  const [lng2, lat2] = p2
  return lng1 < lng2 || (lng1 === lng2 && lat1 < lat2)
    ? `${lng1},${lat1},${lng2},${lat2}`
    : `${lng2},${lat2},${lng1},${lat1}`
}

function bboxInView(bbox, view) {
  const [minLng, minLat, maxLng, maxLat] = bbox
  const tl = latLngToCanvas(maxLat, minLng, view)
  const br = latLngToCanvas(minLat, maxLng, view)
  return !(br.x < -50 || tl.x > view.width + 50 || tl.y > view.height + 50 || br.y < -50)
}
