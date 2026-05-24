import { latLngToCanvas } from '../../atc/stars/canvas/projection.js'

const CIRCLE_RADIUS  = 5   // px — contact symbol
const HISTORY_RADIUS = 3   // px — history dot

const HISTORY_COLORS = ['#AA8800', '#886600', '#664400', '#442200']

/**
 * Draw CATCC contact symbols and history trails on ctx (no clearRect — caller clears).
 *
 *   Untracked: empty gold circle.
 *   Tracked:   position letter (M/A/D/T), no circle.
 *   History:   filled gold dots, dimming oldest→newest per HISTORY_COLORS.
 */
export function drawCatccContacts(
  ctx, view, units, trackMap,
  brite = 80, csPos = 3,
  blinkingUids = new Set(), blinkPhase = false,
  ownership = {}, myControllerId = null,
  history = {}, historyLimit = 5, briteHst = 80,
) {
  const alpha    = Math.max(0, Math.min(1, brite    / 100))
  const alphaHst = Math.max(0, Math.min(1, briteHst / 100))
  if (alpha <= 0) return

  const { width, height } = view
  const fontPx = 8 + csPos * 2
  const maxColorIdx = HISTORY_COLORS.length - 1

  ctx.save()

  for (const [id, unit] of Object.entries(units)) {
    const pos = unit.position
    if (!pos) continue

    const { x, y } = latLngToCanvas(pos.lat, pos.lng, view)
    if (x < -50 || x > width + 50 || y < -50 || y > height + 50) continue

    // --- History trail (drawn first, under contact symbol) ---
    if (alphaHst > 0) {
      const trail = history[id] || []
      const limit = Math.min(trail.length, historyLimit)
      for (let i = 0; i < limit; i++) {
        const hp = latLngToCanvas(trail[i].lat, trail[i].lng, view)
        ctx.globalAlpha = alphaHst
        ctx.fillStyle   = HISTORY_COLORS[Math.min(i, maxColorIdx)]
        ctx.beginPath()
        ctx.arc(hp.x, hp.y, HISTORY_RADIUS, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    // --- Contact symbol ---
    const isBlinking = blinkingUids.has(id)
    const isMine     = !!myControllerId && ownership[id] === myControllerId
    ctx.globalAlpha  = isBlinking
      ? (blinkPhase ? alpha : alpha * 0.60)
      : (isMine ? alpha : alpha * 0.60)

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
