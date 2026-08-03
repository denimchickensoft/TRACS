import { latLngToCanvas } from './projection.js'

const FALLBACK_COLOR = '#556677'

const SUA_CATEGORIES = new Set(['SUA', 'MIL'])

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object}   view       { centerLat, centerLng, pixelsPerNm, width, height }
 * @param {object[]} maps       [{ name, displayCategory, features }] from maps store
 * @param {object}   visible    { [index]: bool, lbl: bool }
 * @param {number}   briteMapA  0–100  MAP A brite (non-SUA geometry)
 * @param {number}   briteMapB  0–100  MAP B brite (SUA geometry + labels)
 * @param {number}   csMap      0–5 (0 = no labels)
 * @param {object}   colors     { [displayCategory]: { stroke, fill, dash, label } } from navdata
 */
export function drawMaps(ctx, view, maps, visible, briteMapA, briteMapB, csMap, colors, polygonFill = 0) {
  const { width, height } = view
  ctx.clearRect(0, 0, width, height)
  if (!maps.length) return

  const alphaA = Math.max(0, Math.min(1, (briteMapA ?? 80) / 100))
  const alphaB = Math.max(0, Math.min(1, (briteMapB ?? 50) / 100))

  // ── Geometry ───────────────────────────────────────────────────────
  for (let i = 0; i < maps.length; i++) {
    if (!visible[i] || !maps[i]) continue
    const { displayCategory } = maps[i]
    const alpha = SUA_CATEGORIES.has(displayCategory) ? alphaB : alphaA
    const entry = colors?.[displayCategory]
    const color = entry?.stroke ?? FALLBACK_COLOR
    const dash  = (entry?.dash ?? []).map(v => v * view.pixelsPerNm)

    const visibleFeatures = maps[i].features.filter(f => bboxInView(f.bbox, view))
    if (!visibleFeatures.length) continue

    // Fill pass — closed polygons, no stroke. Uses the category's `fill`
    // color (distinct from `stroke`, e.g. a lighter wash under a bold
    // outline) rather than reusing the outline color.
    if (polygonFill > 0) {
      ctx.globalAlpha = alpha * (polygonFill / 100)
      ctx.fillStyle   = entry?.fill ?? color
      for (const f of visibleFeatures) {
        drawFill(ctx, view, f)
      }
    }

    // Stroke pass — collect unique edges across all features in this category
    // so that shared boundaries between adjacent polygons are drawn only once,
    // preventing dash-phase overlap that causes uneven thickness.
    const edgeMap = new Map()
    for (const f of visibleFeatures) {
      collectEdges(f, edgeMap)
    }

    ctx.globalAlpha = alpha
    ctx.strokeStyle = color
    ctx.lineWidth   = 1.0
    ctx.setLineDash(dash)
    ctx.beginPath()
    for (const [p1, p2] of edgeMap.values()) {
      const a = latLngToCanvas(p1[1], p1[0], view)
      const b = latLngToCanvas(p2[1], p2[0], view)
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
    }
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1.0
  }

  // ── Labels ─────────────────────────────────────────────────────────
  if (!visible.lbl || csMap <= 0 || briteMapB <= 0) return

  const fontSize = 6 + csMap * 2
  const lineH    = fontSize + 3
  ctx.font         = `${fontSize}px "Roboto Mono", monospace`
  ctx.textAlign    = 'center'
  ctx.textBaseline = 'middle'
  ctx.globalAlpha  = Math.max(0, Math.min(1, briteMapB / 100))

  for (let i = 0; i < maps.length; i++) {
    if (!visible[i] || !maps[i]) continue
    const { displayCategory } = maps[i]
    ctx.fillStyle = colors?.[displayCategory]?.stroke ?? FALLBACK_COLOR

    for (const f of maps[i].features) {
      if (!bboxInView(f.bbox, view)) continue

      const label1 = f.isParent ? (f.nameLabel ?? null) : null
      const label2 = f.altLabel ?? null
      if (!label1 && !label2) continue

      const lines = [label1, label2].filter(Boolean)
      const minLenPx = ctx.measureText(lines[0]).width

      // Approximate centroid from bbox
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
  }

  ctx.globalAlpha = 1.0
}

// Draw filled polygon area for a feature (no stroke).
function drawFill(ctx, view, feature) {
  const polygons = feature.geometry.type === 'Polygon'
    ? [feature.geometry.coordinates]
    : feature.geometry.coordinates

  for (const poly of polygons) {
    ctx.beginPath()
    const ring = poly[0]
    for (let j = 0; j < ring.length - 1; j++) {
      const [lng, lat] = ring[j]
      const { x, y } = latLngToCanvas(lat, lng, view)
      if (j === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.fill()
  }
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

function bboxInView(bbox, view) {
  const [minLng, minLat, maxLng, maxLat] = bbox
  const tl = latLngToCanvas(maxLat, minLng, view)
  const br = latLngToCanvas(minLat, maxLng, view)
  return !(br.x < -50 || tl.x > view.width + 50 || tl.y > view.height + 50 || br.y < -50)
}
