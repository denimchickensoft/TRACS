import { M_TO_FT } from './units.js'

/**
 * Whether MSAW is disabled for a flight plan: set explicitly by MULTI FUNC V,
 * otherwise VFR plans are inhibited and IFR plans aren't.
 */
export function planMsawDisabled(plan) {
  if (!plan) return false
  if (plan.msawDisabled != null) return !!plan.msawDisabled
  return plan.flightRules === 'VFR'
}

/**
 * Whether MSAW is disabled for a track: its flight plan's setting when it
 * has one, otherwise the scope-local MULTI FUNC V setting on the track.
 */
export function msawDisabledFor(plan, trackDisabled) {
  return plan ? planMsawDisabled(plan) : !!trackDisabled
}

/** Altitude in feet from a unit position's metres, or null. */
export function unitAltFt(unit) {
  const alt = unit?.position?.alt
  return alt == null ? null : alt * M_TO_FT
}
