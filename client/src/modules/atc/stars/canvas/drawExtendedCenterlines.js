import { latLngToCanvas } from './projection.js'

const TOTAL_NM = 20
const START_NM = 1   // first dash begins 1 NM from threshold
const DASH_NM  = 1
const GAP_NM   = 1

export function drawExtendedCenterlines(ctx, view, centerlines, cltrVisible, brite = 50) {
  if (!centerlines.length || brite <= 0) return

  const alpha    = Math.max(0, Math.min(1, brite / 100))
  const alphaRwy = alpha
  const { width, height } = view

  ctx.save()
  ctx.lineWidth = 1.5
  ctx.lineCap   = 'butt'

  for (const cl of centerlines) {
    if (!cltrVisible[cl.id]) continue

    // ── Runway pavement ───────────────────────────────────────────────
    ctx.strokeStyle = `rgba(192,192,192,${alphaRwy})`
    const rp1 = latLngToCanvas(cl.rwyEnd1.lat, cl.rwyEnd1.lng, view)
    const rp2 = latLngToCanvas(cl.rwyEnd2.lat, cl.rwyEnd2.lng, view)
    const rwyOffscreen =
      (rp1.x < -50 && rp2.x < -50) || (rp1.x > width + 50 && rp2.x > width + 50) ||
      (rp1.y < -50 && rp2.y < -50) || (rp1.y > height + 50 && rp2.y > height + 50)
    if (!rwyOffscreen) {
      ctx.beginPath()
      ctx.moveTo(rp1.x, rp1.y)
      ctx.lineTo(rp2.x, rp2.y)
      ctx.stroke()
    }

    // ── Extended centerline dashes ────────────────────────────────────
    ctx.strokeStyle = `rgba(96,96,96,${alpha})`
    const cosLat = Math.cos(cl.thresholdLat * Math.PI / 180)
    const sinH   = Math.sin(cl.headingRad)
    const cosH   = Math.cos(cl.headingRad)

    for (let d = START_NM; d < TOTAL_NM; d += DASH_NM + GAP_NM) {
      const d2 = Math.min(d + DASH_NM, TOTAL_NM)

      const lat1 = cl.thresholdLat + (d  / 60) * cosH
      const lng1 = cl.thresholdLng + (d  / 60) * sinH / cosLat
      const lat2 = cl.thresholdLat + (d2 / 60) * cosH
      const lng2 = cl.thresholdLng + (d2 / 60) * sinH / cosLat

      const p1 = latLngToCanvas(lat1, lng1, view)
      const p2 = latLngToCanvas(lat2, lng2, view)

      if (p1.x < -50 && p2.x < -50) continue
      if (p1.x > width  + 50 && p2.x > width  + 50) continue
      if (p1.y < -50 && p2.y < -50) continue
      if (p1.y > height + 50 && p2.y > height + 50) continue

      ctx.beginPath()
      ctx.moveTo(p1.x, p1.y)
      ctx.lineTo(p2.x, p2.y)
      ctx.stroke()
    }
  }

  ctx.restore()
}
