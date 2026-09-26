'use strict'

// Douglas-Peucker line simplification + coordinate rounding, shared by
// buildRoadsWaterData.js and buildOsmLand.js (which shrinks OSM coastline
// vertex density the same way roads/rail/water are).

const SIMPLIFY_TOLERANCE_DEG = 0.0002 // ~20m at these latitudes — see buildRoadsWaterData.js
                                       // for the sizing rationale (matched to the ABM raster's
                                       // ~150m/px render resolution)
const COORD_DECIMALS = 5              // ~1m precision - plenty for this purpose

function round(v, decimals = COORD_DECIMALS) {
  const f = 10 ** decimals
  return Math.round(v * f) / f
}

function perpDistSq([x, y], [x1, y1], [x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1
  let px = x1, py = y1
  if (dx !== 0 || dy !== 0) {
    const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)
    if (t > 1) { px = x2; py = y2 }
    else if (t > 0) { px = x1 + dx * t; py = y1 + dy * t }
  }
  const ddx = x - px, ddy = y - py
  return ddx * ddx + ddy * ddy
}

function douglasPeucker(points, tolSq) {
  const n = points.length
  if (n <= 2) return points
  let maxDist = 0, index = 0
  for (let i = 1; i < n - 1; i++) {
    const d = perpDistSq(points[i], points[0], points[n - 1])
    if (d > maxDist) { maxDist = d; index = i }
  }
  if (maxDist > tolSq) {
    const left = douglasPeucker(points.slice(0, index + 1), tolSq)
    const right = douglasPeucker(points.slice(index), tolSq)
    return left.slice(0, -1).concat(right)
  }
  return [points[0], points[n - 1]]
}

function simplifyAndRound(coords, toleranceDeg = SIMPLIFY_TOLERANCE_DEG, decimals = COORD_DECIMALS) {
  const simplified = douglasPeucker(coords, toleranceDeg * toleranceDeg)
  return simplified.map(([lon, lat]) => [round(lon, decimals), round(lat, decimals)])
}

module.exports = { SIMPLIFY_TOLERANCE_DEG, COORD_DECIMALS, round, douglasPeucker, simplifyAndRound }
