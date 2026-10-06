// Unit conversions shared across the client. DCS/Olympus/Tacview report
// altitude in metres and speed in metres per second.
//
// Every user-facing distance/altitude/speed readout formats through the
// helpers below, keyed by a module's unit system ('imperial' | 'metric',
// see store/unitSystem.js). Internal math stays in NM/ft/kt throughout —
// only display and typed-input parsing convert.

export const M_TO_FT         = 3.28084   // metres → feet
export const MS_TO_KT        = 1.94384   // metres/second → knots
export const MS_TO_KMH       = 3.6       // metres/second → km/h
export const EARTH_RADIUS_NM = 3440.065  // mean Earth radius, nautical miles
export const M_PER_NM        = 1852      // metres per nautical mile
export const NM_TO_FT        = 6076.115  // feet per nautical mile

export const IMPERIAL = 'imperial'
export const METRIC   = 'metric'

const KM_PER_NM = M_PER_NM / 1000

const isMetric = (sys) => sys === METRIC

// ── Horizontal distance (NM in, NM or km out) ───────────────────────────────

export function distFromNm(nm, sys) {
  return isMetric(sys) ? nm * KM_PER_NM : nm
}

// Inverse — a value typed in the display unit, back to NM for storage.
export function distToNm(value, sys) {
  return isMetric(sys) ? value / KM_PER_NM : value
}

export function distUnit(sys) {
  return isMetric(sys) ? 'KM' : 'NM'
}

// `decimals` preserves each call site's existing precision (whole NM on the
// tactical scopes, 2 decimals on STARS RBL/min-sep) — only the unit changes.
export function formatDistance(nm, sys, decimals = 0) {
  const v = distFromNm(nm, sys)
  return `${decimals ? v.toFixed(decimals) : Math.round(v)}${distUnit(sys)}`
}

// Close-in range readouts (ABM/AIC BRAA line and RBL): below one whole
// display unit (1 NM / 1 km) the range switches to the next-smaller unit
// (ft / m) so close-in geometry is readable instead of collapsing to
// "0NM"/"1NM".
export function formatRangeFine(nm, sys) {
  const v = distFromNm(nm, sys)
  if (v >= 1) return `${Math.round(v)}${distUnit(sys)}`
  return isMetric(sys)
    ? `${Math.round(nm * M_PER_NM)}M`
    : `${Math.round(nm * NM_TO_FT)}FT`
}

// ── Altitude / elevation (metres in) ────────────────────────────────────────

export function altFromM(m, sys) {
  return isMetric(sys) ? m : m * M_TO_FT
}

// For source data already in feet (MVA/MSA charts, runway elevations).
export function altFromFt(ft, sys) {
  return isMetric(sys) ? ft / M_TO_FT : ft
}

export function altUnit(sys) {
  return isMetric(sys) ? 'M' : 'FT'
}

export function formatAltitude(m, sys) {
  if (m === null || m === undefined) return 'ELEV N/A'
  return `${Math.round(altFromM(m, sys))}${altUnit(sys)}`
}

// Brevity-style altitude — thousands of ft ("25k") or km to one decimal
// ("7.6km", i.e. 100 m resolution).
export function formatAltThousands(m, sys) {
  return isMetric(sys)
    ? `${(m / 1000).toFixed(1)}km`
    : `${Math.round(m * M_TO_FT / 1000)}k`
}

// Datablock altitude field — hundreds of ft (250 = 25,000 ft) or hundreds
// of m (076 = 7,600 m), zero-padded to 3 digits.
export function altHundreds(m, sys) {
  return String(Math.max(0, Math.round(altFromM(m, sys) / 100))).padStart(3, '0')
}

// ── Speed (metres/second in) ────────────────────────────────────────────────

export function speedFromMs(ms, sys) {
  return isMetric(sys) ? ms * MS_TO_KMH : ms * MS_TO_KT
}

export function speedUnit(sys) {
  return isMetric(sys) ? 'KM/H' : 'KT'
}

// Datablock speed field — tens of kt (45 = 450 kt) or tens of km/h
// (83 = 830 km/h), zero-padded to 2 digits (3 once it reaches 1000).
export function speedTens(ms, sys) {
  return String(Math.round(speedFromMs(ms, sys) / 10)).padStart(2, '0')
}
