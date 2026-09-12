// Draws a selected ATO/FRAG flight's mission-editor route on the ABM scope:
// a polyline through its waypoints, labeled with the mission designer's name
// where given, falling back to WP# (matching Frag.jsx's route list) otherwise.

import { latLngToCanvas } from '../../../utils/projection.js'
import { ZERO_INDEXED_WAYPOINT_TYPES } from '../../../utils/parseMission.js'

const ROUTE_COLOR = '#00CFFF'
const FIX_R = 2.5
const CULL_MARGIN = 60

export function drawAbmFragRoute(ctx, view, route, rawType, groupLabel) {
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

  // Leg label — the flight's group callsign (e.g. "COLT1" for "COLT11"),
  // drawn once on the route's longest leg (by on-screen length) rather than
  // every leg, to avoid cluttering short-hop routes with a repeated label.
  // Same drop-shadow-then-color pattern as drawAbmBraa.js's BRAA label, kept
  // in ROUTE_COLOR so it reads as part of this route, not a BRAA/RBL readout.
  if (groupLabel && pts.length > 1) {
    let longest = null
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]
      const b = pts[i]
      if (!inBounds(a) && !inBounds(b)) continue
      const lenSq = (b.x - a.x) ** 2 + (b.y - a.y) ** 2
      if (!longest || lenSq > longest.lenSq) longest = { a, b, lenSq }
    }
    if (longest) {
      const midX = (longest.a.x + longest.b.x) / 2
      const midY = (longest.a.y + longest.b.y) / 2
      ctx.font = '9px "Roboto Mono", monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = 'rgba(0,0,0,0.4)'
      ctx.fillText(groupLabel, midX + 1, midY - 5)
      ctx.fillStyle = ROUTE_COLOR
      ctx.fillText(groupLabel, midX, midY - 6)
    }
  }

  ctx.fillStyle = ROUTE_COLOR
  ctx.font = '9px "Roboto Mono", monospace'
  ctx.textAlign = 'left'
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
