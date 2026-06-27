const R  = 4          // circumradius for all symbols
const H  = R * 0.866  // ≈ 3.464

/**
 * Returns the display symbol type for a fix identifier based on name length/content.
 *   2–3 chars          → navaid   (flat-top hexagon)
 *   4 chars, all alpha → airport  (hollow circle)
 *   4 chars, alphanum  → intersection (triangle)
 *   5 chars            → intersection (triangle)
 *   anything else      → dot
 */
export function fixSymbolType(id) {
  if (!id) return 'dot'
  const len = id.length
  if (len <= 1 || len >= 6) return 'dot'
  if (len <= 3)             return 'navaid'
  if (len === 5)            return 'intersection'
  return /^[A-Za-z]+$/.test(id) ? 'airport' : 'intersection'
}

/**
 * Draws the appropriate fix symbol at (x, y).
 * ctx must have strokeStyle and fillStyle already set.
 */
export function drawFixSymbol(ctx, x, y, type) {
  switch (type) {
    case 'navaid':
      ctx.beginPath()
      ctx.moveTo(x + R,     y)
      ctx.lineTo(x + R / 2, y - H)
      ctx.lineTo(x - R / 2, y - H)
      ctx.lineTo(x - R,     y)
      ctx.lineTo(x - R / 2, y + H)
      ctx.lineTo(x + R / 2, y + H)
      ctx.closePath()
      ctx.stroke()
      break
    case 'airport':
      ctx.beginPath()
      ctx.arc(x, y, R, 0, Math.PI * 2)
      ctx.stroke()
      break
    case 'intersection':
      ctx.beginPath()
      ctx.moveTo(x,     y - R)
      ctx.lineTo(x - H, y + R * 0.5)
      ctx.lineTo(x + H, y + R * 0.5)
      ctx.closePath()
      ctx.stroke()
      break
    default:
      ctx.beginPath()
      ctx.arc(x, y, 1.5, 0, Math.PI * 2)
      ctx.fill()
      break
  }
}
