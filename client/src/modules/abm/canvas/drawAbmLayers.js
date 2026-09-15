/**
 * ABM static scope layers: range rings (toggleable, anchored on the bullseye
 * or a named fix via .rr) and a bullseye marker. Rings are centered on the
 * scope center, not a fixed anchor circle, since pan is enabled — unlike
 * AIC's bullseye-anchored dugout ring.
 */

import { latLngToCanvas } from '../../../utils/projection.js'

export function drawAbmLayers(
  ctx, view, ringSpacingNm,
  ringAnchorLat, ringAnchorLng, ringAnchorId,
  bullseyeLat, bullseyeLng,
  csMap = 2,
) {
  const { pixelsPerNm, width, height } = view

  ctx.clearRect(0, 0, width, height)

  if (ringSpacingNm > 0) {
    const { x: acx, y: acy } = latLngToCanvas(ringAnchorLat, ringAnchorLng, view)
    ctx.strokeStyle = 'rgba(80,80,80,0.6)'
    ctx.lineWidth   = 0.5
    ctx.setLineDash([])

    const maxRingNm = Math.hypot(width, height) / 2 / pixelsPerNm + ringSpacingNm
    for (let r = ringSpacingNm; r <= maxRingNm; r += ringSpacingNm) {
      ctx.beginPath()
      ctx.arc(acx, acy, r * pixelsPerNm, 0, Math.PI * 2)
      ctx.stroke()
    }

    // Anchor marker only when centered on a named fix (bullseye already has its own marker below)
    if (ringAnchorId) {
      ctx.fillStyle = 'rgba(200,200,200,0.9)'
      ctx.beginPath()
      ctx.arc(acx, acy, 2.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.font = `${6 + csMap * 2}px "Roboto Mono", monospace`
      ctx.fillText(ringAnchorId, acx + 6, acy - 6)
    }
  }

  if (bullseyeLat != null && bullseyeLng != null) {
    const { x, y } = latLngToCanvas(bullseyeLat, bullseyeLng, view)
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth   = 1.5
    ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.stroke()
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.stroke()
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.beginPath(); ctx.arc(x, y, 1.5, 0, Math.PI * 2); ctx.fill()
  }
}
