// Draws a selected ATO/FRAG flight's mission-editor route on the ABM scope:
// a polyline through its waypoints, labeled with the mission designer's name
// where given, falling back to WP# (matching Frag.jsx's route list) otherwise.

import { latLngToCanvas } from '../../../utils/projection.js'
import { ZERO_INDEXED_WAYPOINT_TYPES } from '../../../utils/parseMission.js'

const ROUTE_COLOR = '#00CFFF'
const FIX_R = 2.5
const CULL_MARGIN = 60

export function drawAbmFragRoute(ctx, view, route, rawType) {
  if (!Array.isArray(route) || route.length === 0) return

  const wpLabelOffset = ZERO_INDEXED_WAYPOINT_TYPES.has(rawType) ? 0 : 1
  const pts = route
    .map((wp, i) => ({ wp, i }))
    .filter(({ wp }) => wp.lat != null && wp.lng != null)
    .map(({ wp, i }) => ({
      ...latLngToCanvas(wp.lat, wp.lng, view),
      label: wp.name ?? `WP${i + wpLabelOffset}`,
    }))

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
    ctx.fillText(p.label, p.x + FIX_R + 3, p.y)
  }

  ctx.restore()
}
