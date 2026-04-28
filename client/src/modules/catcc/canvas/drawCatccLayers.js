/**
 * CATCC static and semi-static scope layers:
 *   - Range rings (green)
 *   - CCZ  — 5 nm dashed circle at scope center
 *   - CCA  — 50 nm dashed circle at scope center
 *   - Approach corridor along Final Bearing (FB)
 *   - Marshal radial (dashed, defaults to reciprocal of FB)
 *
 * All circles and bearing lines are drawn in canvas space from the carrier
 * at scope center, using magnetic bearing math (0° = up, CW positive).
 */
export function drawCatccLayers(ctx, view, fb, marshalBearing, rangeNm, ringSpacingNm, brite = 80) {
  const { pixelsPerNm } = view
  const width  = ctx.canvas.width
  const height = ctx.canvas.height
  const cx     = width  / 2
  const cy     = height / 2
  const alpha  = Math.max(0, Math.min(1, brite / 100))

  ctx.clearRect(0, 0, width, height)
  if (alpha <= 0) return

  // ── Range rings — green ──────────────────────────────────────────────────
  ctx.strokeStyle = `rgba(0,200,80,${alpha})`
  ctx.lineWidth   = 0.5
  ctx.setLineDash([])

  const cornerDists = [
    Math.hypot(cx, cy),
    Math.hypot(width - cx, cy),
    Math.hypot(cx, height - cy),
    Math.hypot(width - cx, height - cy),
  ]
  const drawOutNm = Math.max(rangeNm, Math.max(...cornerDists) / pixelsPerNm)

  for (let r = ringSpacingNm; r <= drawOutNm + ringSpacingNm * 0.5; r += ringSpacingNm) {
    ctx.beginPath()
    ctx.arc(cx, cy, r * pixelsPerNm, 0, Math.PI * 2)
    ctx.stroke()
  }

  // ── CCZ — 5 nm dashed yellow circle ─────────────────────────────────────
  ctx.strokeStyle = `rgba(255,200,0,${alpha * 0.55})`
  ctx.lineWidth   = 0.75
  ctx.setLineDash([4, 6])
  ctx.beginPath()
  ctx.arc(cx, cy, 5 * pixelsPerNm, 0, Math.PI * 2)
  ctx.stroke()

  // ── CCA — 50 nm solid yellow circle ─────────────────────────────────────
  ctx.setLineDash([])
  ctx.beginPath()
  ctx.arc(cx, cy, 50 * pixelsPerNm, 0, Math.PI * 2)
  ctx.stroke()

  if (fb == null) return

  // Helper: line from scope center along a magnetic bearing.
  // fwdNm extends toward the bearing; aftNm extends toward the reciprocal.
  function bearingLine(magDeg, fwdNm, aftNm, color, lineWidth, dash = []) {
    const rad  = magDeg * Math.PI / 180
    const sinB = Math.sin(rad)
    const cosB = Math.cos(rad)
    ctx.strokeStyle = color
    ctx.lineWidth   = lineWidth
    ctx.setLineDash(dash)
    ctx.beginPath()
    ctx.moveTo(cx - sinB * aftNm * pixelsPerNm, cy + cosB * aftNm * pixelsPerNm)
    ctx.lineTo(cx + sinB * fwdNm * pixelsPerNm, cy - cosB * fwdNm * pixelsPerNm)
    ctx.stroke()
    ctx.setLineDash([])
  }

  // ── Approach corridor — extends toward inbound aircraft (reciprocal of FB) ──
  bearingLine(marshalBearing, 20, 0, `rgba(255,200,0,${alpha})`, 1)

  // ── Marshal radial — dashed yellow ──────────────────────────────────────
  if (marshalBearing != null) {
    bearingLine(marshalBearing, 120, 0, `rgba(255,200,0,${alpha * 0.5})`, 0.75, [pixelsPerNm, pixelsPerNm])
  }
}
