import { latLngToCanvas } from './projection.js'

const MORA_STROKE_FALLBACK = '#667788'
const MORA_FILL_FALLBACK   = '#99AABB'

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object}   view    { centerLat, centerLng, pixelsPerNm, width, height }
 * @param {object[]} mora    array of { lat, lon, val } — lat/lon = SW corner of 1°×1° cell
 * @param {boolean}  visible
 * @param {number}   brite   0–100
 */
export function drawMora(ctx, view, mora, visible, brite = 50, colors = null) {
  if (!visible || !mora.length || brite <= 0) return

  const { width, height } = view
  const alpha = Math.max(0, Math.min(1, brite / 100))

  const moraEntry  = colors?.MORA
  const moraStroke = moraEntry?.stroke ?? MORA_STROKE_FALLBACK
  const moraFill   = moraEntry?.fill   ?? MORA_FILL_FALLBACK
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.strokeStyle = moraStroke
  ctx.setLineDash((moraEntry?.dash ?? []).map(v => v * view.pixelsPerNm))
  ctx.lineWidth   = 0.5

  for (const cell of mora) {
    const { lat, lon, val } = cell

    // Four corners: SW, SE, NE, NW
    const sw = latLngToCanvas(lat,     lon,     view)
    const se = latLngToCanvas(lat,     lon + 1, view)
    const ne = latLngToCanvas(lat + 1, lon + 1, view)
    const nw = latLngToCanvas(lat + 1, lon,     view)

    const minX = Math.min(sw.x, se.x, ne.x, nw.x)
    const maxX = Math.max(sw.x, se.x, ne.x, nw.x)
    const minY = Math.min(sw.y, se.y, ne.y, nw.y)
    const maxY = Math.max(sw.y, se.y, ne.y, nw.y)

    if (maxX < -5 || minX > width + 5 || maxY < -5 || minY > height + 5) continue

    // Draw cell border
    ctx.beginPath()
    ctx.moveTo(sw.x, sw.y)
    ctx.lineTo(se.x, se.y)
    ctx.lineTo(ne.x, ne.y)
    ctx.lineTo(nw.x, nw.y)
    ctx.closePath()
    ctx.stroke()

    // Cell width in screen pixels — suppress label when too small
    const cellWidthPx = se.x - sw.x
    if (cellWidthPx < 20) continue

    // Centroid
    const cx = (sw.x + se.x + ne.x + nw.x) / 4
    const cy = (sw.y + se.y + ne.y + nw.y) / 4

    const mainStr = String(Math.floor(val / 10))
    const subStr  = String(val % 10)

    // Scale font to cell size, clamped to a readable range
    const mainSize = Math.max(8, Math.min(16, cellWidthPx / 6))
    const subSize  = Math.round(mainSize * 0.65)

    ctx.fillStyle    = moraFill
    ctx.textBaseline = 'middle'

    // Measure to center the combined label
    ctx.font = `italic bold ${mainSize}px "Roboto Mono", monospace`
    const mainW = ctx.measureText(mainStr).width
    ctx.font = `italic bold ${subSize}px "Roboto Mono", monospace`
    const subW  = ctx.measureText(subStr).width

    const startX = cx - (mainW + subW) / 2

    // Main digits
    ctx.font      = `italic bold ${mainSize}px "Roboto Mono", monospace`
    ctx.textAlign = 'left'
    ctx.fillText(mainStr, startX, cy)

    // Superscript digit — offset upward by half the main font size
    ctx.font         = `italic bold ${subSize}px "Roboto Mono", monospace`
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(subStr, startX + mainW, cy - mainSize * 0.35)
  }

  ctx.restore()
}
