// Pure AIC picture/readout helpers (no React, no store access).
import { isOnGround } from '../../utils/visibleUnits.js'
import { gridBearingRangeNm, toMagneticFromTrue } from '../../utils/bearing.js'

export const CARDINAL_ABBR = {
  NORTH: 'N', NORTHEAST: 'NE', EAST: 'E', SOUTHEAST: 'SE',
  SOUTH: 'S', SOUTHWEST: 'SW', WEST: 'W', NORTHWEST: 'NW',
}

// Abbreviates cardinal directions and LEAD/TRAIL in a group's display name.
// The formation amplifier line (e.g. "ECHELON WEST") is rendered separately
// from picture.amplifiers and is NOT run through this — it stays full-word.
const NAME_ABBR = { ...CARDINAL_ABBR, LEAD: 'L', TRAIL: 'T' }
export function abbrGroupName(name) {
  return name.replace(' GROUP', '').split(' ').map(w => NAME_ABBR[w] ?? w).join(' ')
}


export function picFillIns(g) {
  const parts = []
  if (g.isStack) parts.push(`STACK ${g.stackHighFt / 1000}K/${g.stackLowFt / 1000}K`)
  if (g.isHigh) parts.push('HIGH')
  if (g.isVeryFast) parts.push('VERY FAST')
  else if (g.isFast) parts.push('FAST')
  if (g.openingClosing) parts.push(g.openingClosing)
  return parts.join('  ')
}


export function getAicVisibleUnits(units, myCoalitionNum, rwrEverDetected) {
  const result      = {}
  const detectedIds = new Set()

  for (const unit of Object.values(units)) {
    if (!unit.contacts) continue
    for (const c of unit.contacts) {
      if ((c.detectionMethod & 4) || (c.detectionMethod & 32)) detectedIds.add(String(c.ID))
      if (c.detectionMethod & 16) rwrEverDetected?.add(String(c.ID))
    }
  }

  for (const [id, unit] of Object.entries(units)) {
    if (!unit.position) continue
    if (unit.alive === false) continue
    if (unit.category !== 'Aircraft' && unit.category !== 'Helicopter') continue
    if (isOnGround(unit)) continue
    const c = unit.coalition
    if (c === myCoalitionNum || c === 0 || detectedIds.has(id)) result[id] = unit
  }

  return result
}

export function subcardinal(deg) {
  const dirs = ['N','NE','E','SE','S','SW','W','NW']
  return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8]
}

export function bearingRangeFromBullseye(lat, lng, bsLat, bsLng, declinationDeg, theatre) {
  const { gridBearingDeg, rangeNm } = gridBearingRangeNm(bsLat, bsLng, lat, lng, theatre)
  const magBrg = toMagneticFromTrue(gridBearingDeg, declinationDeg)
  return { brg: Math.round(magBrg) || 360, range: Math.round(rangeNm) }
}
