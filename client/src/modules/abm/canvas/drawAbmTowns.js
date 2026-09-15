/**
 * Renders theatre town/city name labels (client/public/towns/[theatre].json)
 * as a standalone text layer — no symbol, just a small dot + label, since
 * unlike fixes/navaids these aren't navigation points, just ground-truth
 * references for controllers building mental geography.
 */

import { latLngToCanvas } from '../../../utils/projection.js'

const CULL_MARGIN = 20
const LABEL_COLOR = 'rgba(180,180,180,0.8)'
const DOT_COLOR   = 'rgba(180,180,180,0.6)'

export function drawAbmTowns(ctx, view, towns, visible, csMap = 2) {
  if (!visible || !towns?.length) return
  const { width, height } = view

  ctx.save()
  ctx.font = `${6 + csMap * 2}px "Roboto Mono", monospace`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'

  for (const t of towns) {
    const { x, y } = latLngToCanvas(t.lat, t.lon, view)
    if (x < -CULL_MARGIN || x > width + CULL_MARGIN || y < -CULL_MARGIN || y > height + CULL_MARGIN) continue
    ctx.fillStyle = DOT_COLOR
    ctx.beginPath()
    ctx.arc(x, y, 1, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = LABEL_COLOR
    ctx.fillText(t.name, x + 4, y)
  }

  ctx.restore()
}
