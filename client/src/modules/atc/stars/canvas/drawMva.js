import { latLngToCanvas, screenBoundsOfBbox } from '../../../../utils/projection.js'

const MVA_STROKE_FALLBACK = '#7788AA'
const MVA_LABEL_FALLBACK  = '#AABBDD'

/**
 * Synthetic MVA layer: discrete labeled sectors, each a conservative minimum
 * vectoring altitude floor. Thin boundary strokes + one altitude label per
 * sector (Grid-MORA style: big main digits + superscript hundreds), placed at
 * the sector's pole-of-inaccessibility. No fill.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object}   view    { centerLat, centerLng, pixelsPerNm, width, height }
 * @param {object[]} mva     array of { alt, label, labelPt, rings, bbox }
 * @param {boolean}  visible
 * @param {number}   brite   0–100
 */
export function drawMva(ctx, view, mva, visible, brite = 50, colors = null) {
  if (!visible || !mva.length || brite <= 0) return

  const { width, height } = view
  const alpha = Math.max(0, Math.min(1, brite / 100))

  const entry  = colors?.MVA
  const stroke = entry?.stroke ?? MVA_STROKE_FALLBACK
  const label  = entry?.fill   ?? MVA_LABEL_FALLBACK

  ctx.save()
  ctx.globalAlpha = alpha
  ctx.strokeStyle = stroke
  ctx.setLineDash((entry?.dash ?? []).map((v) => v * view.pixelsPerNm))
  ctx.lineWidth   = 0.6

  for (const sector of mva) {
    const { x0, x1, y0, y1 } = screenBoundsOfBbox(sector.bbox, view)
    if (x1 < -5 || x0 > width + 5 || y1 < -5 || y0 > height + 5) continue

    // Boundary strokes (outer + holes)
    ctx.beginPath()
    for (const ring of sector.rings) {
      let first = true
      for (const [lon, lat] of ring) {
        const { x, y } = latLngToCanvas(lat, lon, view)
        if (first) { ctx.moveTo(x, y); first = false }
        else ctx.lineTo(x, y)
      }
      ctx.closePath()
    }
    ctx.stroke()

    // Suppress the label when the sector is too small on screen
    const sectorPx = Math.max(x1 - x0, y1 - y0)
    if (sectorPx < 26) continue

    const { x: lx, y: ly } = latLngToCanvas(sector.labelPt[1], sector.labelPt[0], view)

    // Grid-MORA split: hundreds value → big main digits + superscript ones digit
    const hundreds = Math.round(sector.alt / 100)
    const mainStr  = String(Math.floor(hundreds / 10))
    const subStr   = String(hundreds % 10)

    const mainSize = Math.max(9, Math.min(15, sectorPx / 8))
    const subSize  = Math.round(mainSize * 0.65)

    ctx.fillStyle    = label
    ctx.textBaseline = 'middle'

    ctx.font = `italic bold ${mainSize}px "Roboto Mono", monospace`
    const mainW = ctx.measureText(mainStr).width
    ctx.font = `italic bold ${subSize}px "Roboto Mono", monospace`
    const subW  = ctx.measureText(subStr).width

    const startX = lx - (mainW + subW) / 2

    ctx.font      = `italic bold ${mainSize}px "Roboto Mono", monospace`
    ctx.textAlign = 'left'
    ctx.fillText(mainStr, startX, ly)

    ctx.font         = `italic bold ${subSize}px "Roboto Mono", monospace`
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(subStr, startX + mainW, ly - mainSize * 0.35)
  }

  ctx.restore()
}
