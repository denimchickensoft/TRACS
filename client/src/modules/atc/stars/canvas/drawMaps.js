import { latLngToCanvas } from './projection.js'

const FALLBACK_COLOR = '#556677'

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object}   view       { centerLat, centerLng, pixelsPerNm, width, height }
 * @param {object[]} maps       [{ name, features }] from maps store
 * @param {object}   visible    { [index]: bool, lbl: bool }
 * @param {number}   briteGeom  0–100
 * @param {number}   briteLbl   0–100
 * @param {number}   csMap      0–5 (0 = no labels)
 * @param {object}   colors     { [acCode]: { stroke, fill, label } } from navdata
 */
export function drawMaps(ctx, view, maps, visible, briteGeom, briteLbl, csMap, colors, polygonFill = 0) {
  const { width, height } = view
  ctx.clearRect(0, 0, width, height)
  if (!maps.length) return

  const gAlpha = Math.max(0, Math.min(1, (briteGeom ?? 80) / 100))

  // ── Geometry ───────────────────────────────────────────────────────
  for (let i = 0; i < maps.length; i++) {
    if (!visible[i]) continue
    for (const f of maps[i].features) {
      if (!bboxInView(f.bbox, view)) continue
      drawGeometry(ctx, view, f, gAlpha, colors, polygonFill / 100)
    }
  }

  // ── Labels ─────────────────────────────────────────────────────────
  if (!visible.lbl || csMap <= 0 || briteLbl <= 0) return

  const fontSize = 6 + csMap * 2
  const lineH    = fontSize + 3
  ctx.font         = `${fontSize}px "Roboto Mono", monospace`
  ctx.textAlign    = 'center'
  ctx.textBaseline = 'middle'
  ctx.globalAlpha  = Math.max(0, Math.min(1, briteLbl / 100))

  for (let i = 0; i < maps.length; i++) {
    if (!visible[i]) continue
    for (const f of maps[i].features) {
      if (!bboxInView(f.bbox, view)) continue

      const typePrefix = colors?.[f.acCode]?.label ?? f.acCode ?? 'ASP'
      ctx.fillStyle = colors?.[f.acCode]?.stroke ?? FALLBACK_COLOR

      if (isCircular(f.geometry, f.centroid)) {
        const [cLng, cLat] = f.centroid
        const { x, y } = latLngToCanvas(cLat, cLng, view)
        if (x < -50 || x > width + 50 || y < -50 || y > height + 50) continue
        const lines = [typePrefix, f.ceiling, '-----', f.floor]
        lines.forEach((line, idx) => {
          ctx.fillText(line, x, y + (idx - 1.5) * lineH)
        })
      } else {
        const { mx, my, angle } = longestEdge(f.geometry, view)
        if (mx < -50 || mx > width + 50 || my < -50 || my > height + 50) continue
        const [cLng, cLat] = f.centroid
        const cc      = latLngToCanvas(cLat, cLng, view)
        const inwardY = -(cc.x - mx) * Math.sin(angle) + (cc.y - my) * Math.cos(angle)
        const yOffset = Math.sign(inwardY || 1) * (fontSize / 2 + 2)
        ctx.save()
        ctx.translate(mx, my)
        ctx.rotate(angle)
        ctx.fillText(`${typePrefix} ${f.floor} - ${f.ceiling}`, 0, yOffset)
        ctx.restore()
      }
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

// Returns the midpoint and canvas angle of the longest edge across all rings.
function longestEdge(geometry, view) {
  const polygons = geometry.type === 'Polygon'
    ? [geometry.coordinates]
    : geometry.coordinates

  let bestLen = -1, mx = 0, my = 0, angle = 0

  for (const poly of polygons) {
    const ring = poly[0]
    let prev = latLngToCanvas(ring[0][1], ring[0][0], view)
    for (let j = 1; j < ring.length; j++) {
      const cur = latLngToCanvas(ring[j][1], ring[j][0], view)
      const dx  = cur.x - prev.x
      const dy  = cur.y - prev.y
      const len = Math.hypot(dx, dy)
      if (len > bestLen) {
        bestLen = len
        mx      = (prev.x + cur.x) / 2
        my      = (prev.y + cur.y) / 2
        angle   = Math.atan2(dy, dx)
      }
      prev = cur
    }
  }

  // Normalise so text never renders upside-down
  if (angle >  Math.PI / 2) angle -= Math.PI
  if (angle < -Math.PI / 2) angle += Math.PI

  return { mx, my, angle }
}

function bboxInView(bbox, view) {
  const [minLng, minLat, maxLng, maxLat] = bbox
  const tl = latLngToCanvas(maxLat, minLng, view)
  const br = latLngToCanvas(minLat, maxLng, view)
  return !(br.x < -50 || tl.x > view.width + 50 || tl.y > view.height + 50 || br.y < -50)
}

function drawGeometry(ctx, view, feature, alpha, colors, fillAlpha = 0) {
  const color    = colors?.[feature.acCode]?.stroke ?? FALLBACK_COLOR
  const polygons = feature.geometry.type === 'Polygon'
    ? [feature.geometry.coordinates]
    : feature.geometry.coordinates

  for (const poly of polygons) {
    ctx.beginPath()
    let first = true
    for (const [lng, lat] of poly[0]) {
      const { x, y } = latLngToCanvas(lat, lng, view)
      if (first) { ctx.moveTo(x, y); first = false }
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
    if (fillAlpha > 0) {
      ctx.globalAlpha = alpha * fillAlpha
      ctx.fillStyle   = color
      ctx.fill()
    }
    ctx.globalAlpha = alpha
    ctx.strokeStyle = color
    ctx.lineWidth   = 1.0
    ctx.stroke()
  }

  ctx.globalAlpha = 1.0
}
