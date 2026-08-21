import { latLngToCanvas } from '../../../../utils/projection.js'

// Maximum pixel distance from cursor to contact centre to count as a hit
const SLEW_THRESHOLD_PX = 20

/**
 * Given a canvas click position, find the nearest visible contact
 * within the slew threshold.
 *
 * @param {{ x: number, y: number }} canvasPos  click position in canvas pixels
 * @param {Object} units   visible units { [id]: unit }
 * @param {object} view    { centerLat, centerLng, pixelsPerNm, width, height }
 * @returns {{ unitId: string, unit: object } | null}
 */
export function resolveSlew(canvasPos, units, view) {
  let best     = null
  let bestDist = Infinity

  for (const [id, unit] of Object.entries(units)) {
    const pos = unit.position
    if (!pos) continue

    const { x, y } = latLngToCanvas(pos.lat, pos.lng, view)
    const dist = Math.hypot(canvasPos.x - x, canvasPos.y - y)

    if (dist < SLEW_THRESHOLD_PX && dist < bestDist) {
      bestDist = dist
      best = { unitId: id, unit }
    }
  }

  return best
}
