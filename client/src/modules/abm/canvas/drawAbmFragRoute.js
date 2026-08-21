// Draws a selected ATO/FRAG flight's mission-editor route on the ABM scope:
// a polyline through its waypoints, with labels on whichever points the
// mission designer actually named (unlabeled points just get a small tick).

import { latLngToCanvas } from '../../../utils/projection.js'

const ROUTE_COLOR = '#00CFFF'
const FIX_R = 2.5
const CULL_MARGIN = 60

export function drawAbmFragRoute(ctx, view, route) {
  if (!route || route.length === 0) return

  const pts = route
    .filter(wp => wp.lat != null && wp.lng != null)
    .map(wp => ({ ...latLngToCanvas(wp.lat, wp.lng, view), name: wp.name }))

  if (pts.length === 0) return

  const inBounds = (p) =>
    p.x >= -CULL_MARGIN && p.x <= view.width + CULL_MARGIN &&
    p.y >= -CULL_MARGIN && p.y <= view.height + CULL_MARGIN

  if (!pts.some(inBounds)) return

  ctx.save()

  ctx.strokeStyle = ROUTE_COLOR
  ctx.lineWidth = 1
  ctx.setLineDash([4, 3])
  ctx.beginPath()
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
  ctx.stroke()
  ctx.setLineDash([])

  ctx.fillStyle = ROUTE_COLOR
  ctx.font = '9px "Roboto Mono", monospace'
  ctx.textBaseline = 'middle'

  for (const p of pts) {
    if (!inBounds(p)) continue
    ctx.beginPath()
    ctx.arc(p.x, p.y, FIX_R, 0, Math.PI * 2)
    ctx.fill()
    if (p.name) {
      ctx.fillText(p.name, p.x + FIX_R + 3, p.y)
    }
  }

  ctx.restore()
}
