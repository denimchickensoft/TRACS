import { projectRingCached, screenBoundsOfBbox } from '../../../../utils/projection.js'

const COAST_FALLBACK    = '#6699AA'
const BOUNDARY_FALLBACK = '#557788'

export function drawGeo(ctx, view, boundaries, coastlines, visible, brite = 50, colors = null) {
  if (!visible || brite <= 0) return
  if (!boundaries.length && !coastlines.length) return

  const { width, height } = view
  const alpha = (brite / 100) * 0.7

  ctx.save()
  ctx.globalAlpha = alpha
  ctx.lineWidth   = 1

  // Coastlines — solid stroke
  if (coastlines.length) {
    ctx.strokeStyle = colors?.GEO_COAST?.stroke ?? COAST_FALLBACK
    ctx.setLineDash([])
    for (const seg of coastlines) {
      const { x0, x1, y0, y1 } = screenBoundsOfBbox(seg.bbox, view)
      if (x1 < -5 || x0 > width + 5 || y1 < -5 || y0 > height + 5) continue

      ctx.beginPath()
      const points = projectRingCached(seg.coords, view)
      let first = true
      for (const { x, y } of points) {
        if (first) { ctx.moveTo(x, y); first = false }
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
  }

  // Boundaries — dashed stroke
  if (boundaries.length) {
    ctx.strokeStyle = colors?.GEO_BOUNDARY?.stroke ?? BOUNDARY_FALLBACK
    ctx.setLineDash([4, 3])
    for (const seg of boundaries) {
      const { x0, x1, y0, y1 } = screenBoundsOfBbox(seg.bbox, view)
      if (x1 < -5 || x0 > width + 5 || y1 < -5 || y0 > height + 5) continue

      ctx.beginPath()
      const points = projectRingCached(seg.coords, view)
      let first = true
      for (const { x, y } of points) {
        if (first) { ctx.moveTo(x, y); first = false }
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
  }

  ctx.restore()
}
