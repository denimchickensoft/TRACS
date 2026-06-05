/**
 * AIC static scope layers:
 *   - Range rings
 *   - Gold dugout band at outermost range
 *   - Bullseye marker at scope center
 */

export function drawAicLayers(ctx, view, rangeNm, ringSpacingNm, bullseyeLat, bullseyeLng) {
  const { pixelsPerNm, width, height } = view
  const cx = width  / 2
  const cy = height / 2

  ctx.clearRect(0, 0, width, height)

  // ── Range rings ───────────────────────────────────────────────────────────────
  if (ringSpacingNm > 0) {
    ctx.strokeStyle = 'rgba(80,80,80,0.7)'
    ctx.lineWidth   = 0.5
    ctx.setLineDash([])

    const maxRingNm = rangeNm - 10  // stop at inner edge of dugout band

    for (let r = ringSpacingNm; r <= maxRingNm + ringSpacingNm * 0.01; r += ringSpacingNm) {
      ctx.beginPath()
      ctx.arc(cx, cy, r * pixelsPerNm, 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  // ── Gold dugout band — 5nm thick annulus at the range edge ───────────────────
  const outerR = rangeNm * pixelsPerNm
  const innerR = Math.max(0, (rangeNm - 10) * pixelsPerNm)

  ctx.fillStyle = '#54492A'
  ctx.beginPath()
  ctx.arc(cx, cy, outerR, 0, Math.PI * 2, false)
  ctx.arc(cx, cy, innerR, 0, Math.PI * 2, true)
  ctx.fill()

  ctx.strokeStyle = 'rgba(255,255,255,1)'
  ctx.lineWidth   = 1
  ctx.setLineDash([6, 6])

  ctx.beginPath()
  ctx.arc(cx, cy, outerR, 0, Math.PI * 2)
  ctx.stroke()

  ctx.beginPath()
  ctx.arc(cx, cy, innerR, 0, Math.PI * 2)
  ctx.stroke()

  ctx.setLineDash([])

}
