import { latLngToCanvas } from '../../../../utils/projection.js'

export function drawObstructions(ctx, view, obstructions, visible, brite = 80) {
  if (!visible || !obstructions.length || brite <= 0) return

  const alpha = Math.max(0, Math.min(1, brite / 100))
  const { width, height } = view

  ctx.save()
  ctx.fillStyle    = `rgba(160,160,160,${alpha})`
  ctx.font         = '10px "Roboto Mono", monospace'
  ctx.textAlign    = 'center'
  ctx.textBaseline = 'alphabetic'

  const m       = ctx.measureText('^')
  const yOffset = (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2

  for (const ob of obstructions) {
    const { x, y } = latLngToCanvas(ob.lat, ob.lng, view)
    if (x < -10 || x > width + 10 || y < -10 || y > height + 10) continue
    ctx.fillText('^', x, y + yOffset)
  }

  ctx.restore()
}
