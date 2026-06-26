import { latLngToCanvas } from './projection.js'

const ROUTE_FALLBACK = '#C8AA88'
const GAP_DASH       = [6, 5]
const DOT_RADIUS     = 2

/**
 * Draw flight plan routes for one or more aircraft.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object}  view        { centerLat, centerLng, pixelsPerNm, width, height }
 * @param {Map}     routesByUid uid → { segments, missing, fixLabels }
 * @param {number}  brite       0–100
 * @param {number}  csMap       0–5 character size index
 * @param {object}  colors      active palette colors object, or null
 */
export function drawRoute(ctx, view, routesByUid, brite = 50, csMap = 2, colors = null) {
  if (!routesByUid?.size || brite <= 0) return

  const alpha  = Math.max(0, Math.min(1, brite / 100))
  const color  = colors?.ROUTE?.stroke ?? ROUTE_FALLBACK
  const fSize  = Math.max(8, 6 + csMap * 2)

  ctx.save()
  ctx.globalAlpha  = alpha
  ctx.strokeStyle  = color
  ctx.fillStyle    = color
  ctx.lineWidth    = 1

  for (const { segments, missing, fixLabels } of routesByUid.values()) {
    // ── Line segments ────────────────────────────────────────────
    for (const seg of (segments ?? [])) {
      if (!seg.points || seg.points.length < 2) continue
      ctx.setLineDash(seg.dashed ? GAP_DASH : [])
      ctx.beginPath()
      const first = latLngToCanvas(seg.points[0].lat, seg.points[0].lon, view)
      ctx.moveTo(first.x, first.y)
      for (let k = 1; k < seg.points.length; k++) {
        const { x, y } = latLngToCanvas(seg.points[k].lat, seg.points[k].lon, view)
        ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
    ctx.setLineDash([])

    // ── Fix dots and idents ──────────────────────────────────────
    if (csMap > 0) {
      ctx.font         = `${fSize}px "Roboto Mono", monospace`
      ctx.textAlign    = 'left'
      ctx.textBaseline = 'alphabetic'
    }
    for (const fl of (fixLabels ?? [])) {
      const { x, y } = latLngToCanvas(fl.lat, fl.lon, view)
      ctx.beginPath()
      ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2)
      ctx.fill()
      if (csMap > 0 && fl.id) ctx.fillText(fl.id, x + 4, y - 3)
    }

    // ── '?' markers for unresolved waypoints ─────────────────────
    // Offset perpendicular to the gap segment so the label doesn't overlap the line.
    ctx.font         = `bold ${fSize}px "Roboto Mono", monospace`
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    const PERP_OFFSET = fSize + 2
    for (const m of (missing ?? [])) {
      const mid = latLngToCanvas(m.lat, m.lon, view)
      let ox = 0, oy = -PERP_OFFSET  // default: offset upward
      if (m.a && m.b) {
        const pa = latLngToCanvas(m.a.lat, m.a.lon, view)
        const pb = latLngToCanvas(m.b.lat, m.b.lon, view)
        const dx = pb.x - pa.x
        const dy = pb.y - pa.y
        const len = Math.hypot(dx, dy)
        if (len > 0) {
          // Perpendicular unit vector (rotate 90° CCW)
          ox = (-dy / len) * PERP_OFFSET
          oy = ( dx / len) * PERP_OFFSET
        }
      }
      ctx.fillText('?', mid.x + ox, mid.y + oy)
    }
  }

  ctx.restore()
}
