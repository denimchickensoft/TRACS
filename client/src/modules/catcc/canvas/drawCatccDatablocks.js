import { latLngToCanvas } from '../../atc/canvas/projection.js'

const M_TO_FT = 3.28084

/**
 * Draw limited data blocks for CATCC-owned contacts.
 *
 * Called after drawContacts on the same canvas (no clearRect).
 * Only renders for contacts present in the ownership map.
 *
 * Data block layout (upper-right of contact symbol):
 *   Line 1 — side number (modex) if correlated, else callsign/AID
 *   Line 2 — altitude, hundreds of feet, zero-padded to 3 digits
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object}  view          { centerLat, centerLng, pixelsPerNm, width, height }
 * @param {object}  units         { [id]: unit }
 * @param {object}  ownership     { [unitId]: positionName }
 * @param {object}  correlations  { [unitId]: sideNumber string }
 * @param {object}  labelMap      { [unitId]: string } — pre-resolved callsign/AID fallback
 * @param {number}  brite         0–100
 */
export function drawCatccDatablocks(ctx, view, units, ownership, correlations, labelMap, brite = 80) {
  const alpha = Math.max(0, Math.min(1, brite / 100))
  if (alpha <= 0) return

  const width  = ctx.canvas.width
  const height = ctx.canvas.height

  const DX          = 10   // px right of symbol center
  const DY          = -4   // px above symbol center (first line baseline)
  const LINE_HEIGHT = 11   // px between lines

  ctx.font         = '10px "Roboto Mono", monospace'
  ctx.textAlign    = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle    = `rgba(255,215,0,${alpha})`

  for (const [id, unit] of Object.entries(units)) {
    if (!ownership[String(id)]) continue

    const pos = unit.position
    if (!pos) continue

    const { x, y } = latLngToCanvas(pos.lat, pos.lng, view)
    if (x < -100 || x > width + 100 || y < -100 || y > height + 100) continue

    const sideNumber = correlations[String(id)]
    const line1 = sideNumber ?? labelMap[id] ?? String(id)

    const altFt   = (pos.alt ?? 0) * M_TO_FT
    const line2   = Math.round(altFt / 100).toString().padStart(3, '0')

    ctx.fillText(line1, x + DX, y + DY)
    ctx.fillText(line2, x + DX, y + DY + LINE_HEIGHT)
  }
}
