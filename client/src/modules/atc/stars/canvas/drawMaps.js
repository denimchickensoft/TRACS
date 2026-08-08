import { latLngToCanvas } from './projection.js'
import { placeAirspaceLabels } from '../../../../utils/airspaceLabelPlacement.js'

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

  const items = []
  for (let i = 0; i < maps.length; i++) {
    if (!visible[i] || !maps[i]) continue
    const { displayCategory } = maps[i]
    const color = colors?.[displayCategory]?.stroke ?? FALLBACK_COLOR

    for (const f of maps[i].features) {
      if (!bboxInView(f.bbox, view)) continue

      const label1 = f.isParent ? (f.nameLabel ?? null) : null
      const label2 = f.altLabel ?? null
      if (!label1 && !label2) continue

      const lines = [label1, label2].filter(Boolean)
      items.push({ feature: f, lines, lineWidths: lines.map(l => ctx.measureText(l).width), fontSize, color })
    }
  }

  ctx.globalAlpha = Math.max(0, Math.min(1, briteMapB / 100))
  for (const { lines, x, y, angle, color } of placeAirspaceLabels(items, view)) {
    ctx.fillStyle = color
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(angle)
    lines.forEach((line, idx) => {
      ctx.fillText(line, 0, (idx - (lines.length - 1) / 2) * lineH)
    })
    ctx.restore()
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

function bboxInView(bbox, view) {
  const [minLng, minLat, maxLng, maxLat] = bbox
  const tl = latLngToCanvas(maxLat, minLng, view)
  const br = latLngToCanvas(minLat, maxLng, view)
  return !(br.x < -50 || tl.x > view.width + 50 || tl.y > view.height + 50 || br.y < -50)
}
