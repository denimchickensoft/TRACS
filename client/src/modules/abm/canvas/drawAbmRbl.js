/**
 * ABM RBL (range/bearing line) — ported verbatim from AIC's drawRbl
 * (drawAicContacts.js). Dashed while dragging, solid once fixed on mouseup,
 * endpoint dots, bearing/range label at the midpoint.
 */

import { latLngToCanvas } from '../../atc/stars/canvas/projection.js'
import { trueBearingRangeNm, toMagneticFromTrue } from '../../../utils/bearing.js'

export function drawRbl(ctx, view, rbl, declinationDeg) {
  if (!rbl?.anchor || !rbl?.end) return

  const ap = latLngToCanvas(rbl.anchor.lat, rbl.anchor.lng, view)
  const ep = latLngToCanvas(rbl.end.lat,    rbl.end.lng,    view)

  ctx.strokeStyle = rbl.fixed ? 'rgba(167,167,167,0.85)' : 'rgba(167,167,167,0.5)'
  ctx.lineWidth   = 1
  ctx.setLineDash(rbl.fixed ? [] : [5, 5])
  ctx.beginPath()
  ctx.moveTo(ap.x, ap.y)
  ctx.lineTo(ep.x, ep.y)
  ctx.stroke()
  ctx.setLineDash([])

  ctx.fillStyle = 'rgba(167,167,167,0.9)'
  ctx.beginPath(); ctx.arc(ap.x, ap.y, 3, 0, Math.PI * 2); ctx.fill()
  ctx.beginPath(); ctx.arc(ep.x, ep.y, 3, 0, Math.PI * 2); ctx.fill()

  const { trueBearingDeg, rangeNm } = trueBearingRangeNm(rbl.anchor.lat, rbl.anchor.lng, rbl.end.lat, rbl.end.lng)
  const range  = Math.round(rangeNm)
  const magBrg = Math.round(toMagneticFromTrue(trueBearingDeg, declinationDeg)) || 360
  const label  = `${String(magBrg).padStart(3, '0')}°M  ${range}NM`

  const midX = (ap.x + ep.x) / 2
  const midY = (ap.y + ep.y) / 2

  ctx.font      = '11px "Roboto Mono", monospace'
  ctx.textAlign = 'center'
  ctx.fillStyle = 'rgba(0,0,0,0.4)'
  ctx.fillText(label, midX + 1, midY - 5)
  ctx.fillStyle = 'rgba(167,167,167,0.9)'
  ctx.fillText(label, midX, midY - 6)
}
