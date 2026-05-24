import { latLngToCanvas } from './projection.js'

export function drawRunways(ctx, view, runwayMaps, rwyVisible, brite = 80) {
  if (!runwayMaps.length || brite <= 0) return

  const { width, height } = view
  const alpha = Math.max(0, Math.min(1, brite / 100))

  ctx.save()
  ctx.strokeStyle = `rgba(255,255,255,${alpha})`
  ctx.lineWidth   = 1.5
  ctx.lineCap     = 'butt'

  for (const rwy of runwayMaps) {
    if (!rwyVisible[rwy.id]) continue

    const p1 = latLngToCanvas(rwy.end1.lat, rwy.end1.lng, view)
    const p2 = latLngToCanvas(rwy.end2.lat, rwy.end2.lng, view)

    if (p1.x < -50 && p2.x < -50) continue
    if (p1.x > width + 50 && p2.x > width + 50) continue
    if (p1.y < -50 && p2.y < -50) continue
    if (p1.y > height + 50 && p2.y > height + 50) continue

    ctx.beginPath()
    ctx.moveTo(p1.x, p1.y)
    ctx.lineTo(p2.x, p2.y)
    ctx.stroke()
  }

  ctx.restore()
}
