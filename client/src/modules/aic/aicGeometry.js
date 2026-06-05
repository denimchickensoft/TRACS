/**
 * Shared AIC intercept geometry.
 * Single source of truth for merge point, TTI, and intercept heading.
 */

const safeNum = (v, d = 0) => (typeof v === 'number' && isFinite(v)) ? v : d

/**
 * Compute the intercept solution between a fighter and a bogey.
 *
 * Returns { ttiHours, interceptRad, mergeLat, mergeLng } or null if no
 * valid intercept exists within 2 hours.
 *
 * interceptRad — true-north bearing (radians) the fighter should fly.
 * mergeLat/Lng — geographic position of the predicted merge point.
 */
export function computeAicIntercept(fighter, bogey) {
  const fp = fighter.position, bp = bogey.position
  if (!fp || !bp) return null

  const fSpdKts = safeNum(fighter.speed) * 1.94384
  const bSpdKts = safeNum(bogey.speed)   * 1.94384
  if (fSpdKts < 10) return null

  const avgLat      = (fp.lat + bp.lat) / 2
  const nmPerDegLng = 60 * Math.cos(avgLat * Math.PI / 180)
  const dN          = (bp.lat - fp.lat) * 60
  const dE          = (bp.lng - fp.lng) * nmPerDegLng
  const rangeNm     = Math.hypot(dN, dE)
  if (rangeNm < 0.05) return null

  const bearingRad = Math.atan2(dE, dN)
  const bogeyTrack = safeNum(bogey.track)

  // Aspect: angle between bogey track and bearing back to fighter, folded to [0, π]
  let aspectRad = (bogeyTrack - (bearingRad + Math.PI)) % (2 * Math.PI)
  if (aspectRad < 0) aspectRad += 2 * Math.PI
  if (aspectRad > Math.PI) aspectRad = 2 * Math.PI - aspectRad

  // Law of sines: sin(φ_fighter) = (bSpd / fSpd) * sin(aspect)
  const rawSinCorr = bSpdKts > 0 ? (bSpdKts / fSpdKts) * Math.sin(aspectRad) : 0
  if (rawSinCorr > 1) return null  // bogey geometry makes intercept impossible

  const corrRad      = Math.asin(rawSinCorr)
  const signedCorr   = Math.sin(bogeyTrack - bearingRad) < 0 ? -corrRad : corrRad
  const interceptRad = bearingRad + signedCorr

  // Kinematic TTI: solve fSpd·T·û_intercept − bSpd·T·û_bogey = (dN, dE)
  // Use the axis with the larger denominator for numerical stability.
  const denomN = fSpdKts * Math.cos(interceptRad) - bSpdKts * Math.cos(bogeyTrack)
  const denomE = fSpdKts * Math.sin(interceptRad) - bSpdKts * Math.sin(bogeyTrack)
  const useDN  = Math.abs(denomN) >= Math.abs(denomE)
  const denom  = useDN ? denomN : denomE
  const dist   = useDN ? dN     : dE
  if (Math.abs(denom) < 0.01) return null

  const ttiHours = dist / denom
  if (ttiHours <= 0 || ttiHours > 2) return null

  const mergeN = dN + bSpdKts * ttiHours * Math.cos(bogeyTrack)
  const mergeE = dE + bSpdKts * ttiHours * Math.sin(bogeyTrack)

  return {
    ttiHours,
    interceptRad,
    mergeLat: fp.lat + mergeN / 60,
    mergeLng: fp.lng + mergeE / nmPerDegLng,
  }
}
