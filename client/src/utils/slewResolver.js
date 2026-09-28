import { latLngToCanvas } from './projection.js'

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

// Declaration-only multi-select, used by ABM and AIC. Everything else (BRAA,
// threat rings, bogey dope, leader-dir override) uses resolveSlew above,
// which picks the single nearest hit. In a tight formation or a dense
// ground/naval cluster "nearest wins" can leave a contact unreachable
// wherever you click, so F1-F4 + click declares every contact within this
// radius at once.
const DECLARE_CLICK_RADIUS_PX = 10

export function resolveDeclareTargets(canvasPos, units, view) {
  const hits = []
  for (const [id, unit] of Object.entries(units)) {
    const pos = unit.position
    if (!pos) continue
    const { x, y } = latLngToCanvas(pos.lat, pos.lng, view)
    if (Math.hypot(canvasPos.x - x, canvasPos.y - y) < DECLARE_CLICK_RADIUS_PX) {
      hits.push({ unitId: id, unit })
    }
  }
  return hits
}
