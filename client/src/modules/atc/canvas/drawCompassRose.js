/**
 * Compass Rose — tick marks and heading labels along the scope edge.
 *
 * Tick marks every 5°, 3-digit labels every 10°, radiating from the scope
 * center outward. Matches STARS/VICE behaviour.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} view       { centerLat, centerLng, pixelsPerNm, width, height }
 * @param {number} briteCmp   0–100 brightness (0 = hidden)
 * @param {number} csTools    0–5 character size index (default 3)
 */
export function drawCompassRose(ctx, view, briteCmp = 70, csTools = 3) {
  if (briteCmp <= 0) {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    return
  }

  const width  = ctx.canvas.width
  const height = ctx.canvas.height

  ctx.clearRect(0, 0, width, height)

  const gray  = Math.round(Math.max(0, Math.min(100, briteCmp)) / 100 * 255)
  const color = `rgb(${gray},${gray},${gray})`

  // Scope center in canvas pixels
  const cx = width  / 2
  const cy = height / 2

  const TICK_LEN  = 10   // px from edge inward
  const LABEL_GAP = 14   // px from edge inward to text anchor

  const fontPx = 10 + csTools * 2

  ctx.strokeStyle = color
  ctx.lineWidth   = 1
  ctx.font        = `${fontPx}px monospace`
  ctx.fillStyle   = color
  ctx.textAlign   = 'left'
  ctx.textBaseline = 'top'

  for (let h = 5; h <= 360; h += 5) {
    // Canvas bearing: 0° = North = up = negative Y direction.
    // sin for X (east positive), -cos for Y (north = negative canvas-Y).
    const rad = (h * Math.PI) / 180
    const dx  =  Math.sin(rad)
    const dy  = -Math.cos(rad)

    // Parametric intersection with scope rectangle edges.
    // Find smallest positive t such that cx+t*dx or cy+t*dy hits a wall.
    let t = Infinity
    if (dx > 0) t = Math.min(t, (width  - cx) / dx)
    if (dx < 0) t = Math.min(t, (0      - cx) / dx)
    if (dy > 0) t = Math.min(t, (height - cy) / dy)
    if (dy < 0) t = Math.min(t, (0      - cy) / dy)

    if (!isFinite(t)) continue

    const ex = cx + dx * t
    const ey = cy + dy * t
    const ix = cx + dx * (t - TICK_LEN)
    const iy = cy + dy * (t - TICK_LEN)

    ctx.beginPath()
    ctx.moveTo(ex, ey)
    ctx.lineTo(ix, iy)
    ctx.stroke()

    if (h % 10 === 0) {
      const label = String(h).padStart(3, '0')

      // Measure text to center it on the tick
      const tw = ctx.measureText(label).width
      const th = fontPx

      // Anchor point: inset a bit further than the tick end
      const ax = cx + dx * (t - LABEL_GAP)
      const ay = cy + dy * (t - LABEL_GAP)

      // Which edge? Use which boundary t hit to decide alignment.
      let lx, ly
      const onLeft   = Math.abs(ex)       < 0.5
      const onRight  = Math.abs(ex - width)  < 0.5
      const onTop    = Math.abs(ey)       < 0.5
      // bottom otherwise

      if (onLeft) {
        // Left edge: text goes to the right of the tick, vertically centered
        lx = ax
        ly = ay - th / 2
      } else if (onRight) {
        // Right edge: text goes to the left of the tick, vertically centered
        lx = ax - tw
        ly = ay - th / 2
      } else if (onTop) {
        // Top edge: text horizontally centered, below the tick
        lx = ax - tw / 2
        ly = ay
      } else {
        // Bottom edge: text horizontally centered, above the tick
        lx = ax - tw / 2
        ly = ay - th
      }

      ctx.fillText(label, lx, ly)
    }
  }
}
