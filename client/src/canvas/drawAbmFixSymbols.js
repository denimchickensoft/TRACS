/**
 * Renders theatre fixes/navaids as a standalone point layer. Reuses the
 * existing glyph logic from STARS's fixSymbol.js (hexagon/circle/triangle/dot
 * by ID shape) — that logic already exists, it's just never been called
 * outside of route/hold rendering until now. Ident labels (gated by the
 * ABM `.labels` toggle, same as airspace/custom-drawing names) use the same
 * offset-right-of-symbol convention drawRoute.js's fix labels already do.
 */

import { latLngToCanvas } from '../utils/projection.js'
import { fixSymbolType, drawFixSymbol } from './fixSymbol.js'

const CULL_MARGIN = 20

export function drawAbmFixSymbols(ctx, view, points, visible, color, brite = 60, labelsVisible = false, csMap = 2) {
  if (!visible || !points?.length || brite <= 0) return
  const { width, height } = view
  const alpha = Math.max(0, Math.min(1, brite / 100))

  ctx.save()
  ctx.globalAlpha = alpha
  ctx.strokeStyle = color
  ctx.fillStyle   = color
  ctx.lineWidth   = 1
  if (labelsVisible) {
    ctx.font         = `${6 + csMap * 2}px "Roboto Mono", monospace`
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'alphabetic'
  }

  for (const p of points) {
    const { x, y } = latLngToCanvas(p.lat, p.lon, view)
    if (x < -CULL_MARGIN || x > width + CULL_MARGIN || y < -CULL_MARGIN || y > height + CULL_MARGIN) continue
    drawFixSymbol(ctx, x, y, fixSymbolType(p.id))
    if (labelsVisible && p.id) ctx.fillText(p.id, x + 4, y - 3)
  }

  ctx.restore()
}
