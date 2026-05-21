import { latLngToCanvas } from '../../atc/canvas/projection.js'

// PTL and history trails are disabled for now — do not delete:
// To re-enable, add (history, ptl, briteHst, historyLimit) parameters and draw
// history dots + PTL line here before the main contact symbol.

const CIRCLE_RADIUS = 5  // px

/**
 * Draw CATCC contact symbols on ctx (no clearRect — caller must clear).
 *
 *   Untracked (no ownership entry): empty yellow circle.
 *   Tracked   (has ownership):      position letter (M/A/D/T), no circle.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} view       { centerLat, centerLng, pixelsPerNm, width, height }
 * @param {object} units      { [id]: unit }
 * @param {object} trackMap   { [id]: letter } — only tracked contacts present
 * @param {number} brite      0–100
 * @param {number} csPos      0–5 symbol size (default 3)
 */
export function drawCatccContacts(ctx, view, units, trackMap, brite = 80, csPos = 3, blinkingUids = new Set(), blinkPhase = false, ownership = {}, myControllerId = null) {
  const alpha = Math.max(0, Math.min(1, brite / 100))
  if (alpha <= 0) return

  const { width, height } = view
  const fontPx = 8 + csPos * 2

  ctx.save()

  for (const [id, unit] of Object.entries(units)) {
    const pos = unit.position
    if (!pos) continue

    const { x, y } = latLngToCanvas(pos.lat, pos.lng, view)
    if (x < -50 || x > width + 50 || y < -50 || y > height + 50) continue

    const isBlinking = blinkingUids.has(id)
    const isMine     = !!myControllerId && ownership[id] === myControllerId
    if (isBlinking) {
      ctx.globalAlpha = blinkPhase ? alpha : alpha * 0.60
    } else {
      ctx.globalAlpha = isMine ? alpha : alpha * 0.60
    }

    const letter = trackMap[id]

    if (letter) {
      ctx.font         = `bold ${fontPx}px "Roboto Mono", monospace`
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'alphabetic'
      ctx.fillStyle    = '#FFD700'
      const m    = ctx.measureText(letter)
      const yOff = (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2
      ctx.fillText(letter, x, y + yOff)
    } else {
      ctx.strokeStyle = '#FFD700'
      ctx.lineWidth   = 1.5
      ctx.beginPath()
      ctx.arc(x, y, CIRCLE_RADIUS, 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  ctx.restore()
}
