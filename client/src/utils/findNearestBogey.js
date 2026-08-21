import { localOffsetNm } from './bearing.js'

// Flat-earth range between two {lat,lng} points, scaled from `a`'s latitude only
// (not the midpoint trueBearingRangeNm uses) — same convention as localOffsetNm,
// which this delegates to.
export function nmBetween(a, b) {
  const { eastNm, northNm } = localOffsetNm(a.lat, a.lng, b.lat, b.lng)
  return Math.hypot(eastNm, northNm)
}

// Nearest non-friendly/neutral unit to `fighterUnit`, by nmBetween distance.
// getDecl(id, unit) resolves each candidate's declaration — callers differ in
// how they look that up (a callback, not a shared lookup, since ABM and AIC
// keep independent declaration state).
export function findNearestBogey(fighterId, fighterUnit, units, getDecl) {
  if (!fighterUnit?.position) return null
  let nearestId = null, nearestDist = Infinity
  for (const [id, unit] of Object.entries(units)) {
    if (id === fighterId || !unit.position) continue
    const decl = getDecl(id, unit)
    if (decl === 'FRIENDLY' || decl === 'NEUTRAL') continue
    const dist = nmBetween(fighterUnit.position, unit.position)
    if (dist < nearestDist) { nearestDist = dist; nearestId = id }
  }
  return nearestId
}
