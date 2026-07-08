/**
 * Renders theatre fixes/navaids as a standalone point layer. Reuses the
 * existing glyph logic from STARS's fixSymbol.js (hexagon/circle/triangle/dot
 * by ID shape) — that logic already exists, it's just never been called
 * outside of route/hold rendering until now.
 */

import { latLngToCanvas } from '../../atc/stars/canvas/projection.js'
import { fixSymbolType, drawFixSymbol } from '../../atc/stars/canvas/fixSymbol.js'

const CULL_MARGIN = 20

export function drawAbmFixSymbols(ctx, view, points, visible, color, brite = 60) {
  if (!visible || !points?.length || brite <= 0) return
  const { width, height } = view
  const alpha = Math.max(0, Math.min(1, brite / 100))

  ctx.save()
  ctx.globalAlpha = alpha
  ctx.strokeStyle = color
  ctx.fillStyle   = color
  ctx.lineWidth   = 1

  for (const p of points) {
    const { x, y } = latLngToCanvas(p.lat, p.lon, view)
    if (x < -CULL_MARGIN || x > width + CULL_MARGIN || y < -CULL_MARGIN || y > height + CULL_MARGIN) continue
    drawFixSymbol(ctx, x, y, fixSymbolType(p.id))
  }

  ctx.restore()
}
