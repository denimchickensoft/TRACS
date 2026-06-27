import { latLngToCanvas } from './projection.js'

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
      const [minLon, minLat, maxLon, maxLat] = seg.bbox
      const sw = latLngToCanvas(minLat, minLon, view)
      const ne = latLngToCanvas(maxLat, maxLon, view)
      const x0 = Math.min(sw.x, ne.x), x1 = Math.max(sw.x, ne.x)
      const y0 = Math.min(sw.y, ne.y), y1 = Math.max(sw.y, ne.y)
      if (x1 < -5 || x0 > width + 5 || y1 < -5 || y0 > height + 5) continue

      ctx.beginPath()
      let first = true
      for (const [lon, lat] of seg.coords) {
        const { x, y } = latLngToCanvas(lat, lon, view)
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
      const [minLon, minLat, maxLon, maxLat] = seg.bbox
      const sw = latLngToCanvas(minLat, minLon, view)
      const ne = latLngToCanvas(maxLat, maxLon, view)
      const x0 = Math.min(sw.x, ne.x), x1 = Math.max(sw.x, ne.x)
      const y0 = Math.min(sw.y, ne.y), y1 = Math.max(sw.y, ne.y)
      if (x1 < -5 || x0 > width + 5 || y1 < -5 || y0 > height + 5) continue

      ctx.beginPath()
      let first = true
      for (const [lon, lat] of seg.coords) {
        const { x, y } = latLngToCanvas(lat, lon, view)
        if (first) { ctx.moveTo(x, y); first = false }
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
  }

  ctx.restore()
}
