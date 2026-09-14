// SRS reports mode3 (the Mode 3/A civilian squawk) as -1 when unset — this
// is independent of the overall `status` field. A real aircraft can be
// status:1 (NORMAL — transponder master on) with mode4 (military IFF) on
// but mode3 never dialed in, e.g. `{ mode3: -1, mode4: true, status: 1 }`.
// From a civilian-ATC-correlation standpoint that's operationally identical
// to standby: there's no code to show on a datablock or match against a
// flight plan, regardless of what `status` says. mode1/mode2 (military
// mission/unit codes) are never used for this — see
// resources/specs/transponder-correlation-spec.md §4.
export function hasLiveSquawk(unit) {
  const t = unit?.transponder
  if (!t) return false
  if (t.status !== 1 && t.status !== 2) return false
  return typeof t.mode3 === 'number' && t.mode3 >= 0
}

// Shared 4-digit octal squawk normalizer — used by any code+callsign
// double-gate match (STARS' associationEngine.js, CATCC's correlation).
export function normalizeCode(code) {
  return String(code ?? '').padStart(4, '0')
}

// AIC's Mode 4 IFF readout/gate. SRS's mode4 is a raw, unauthenticated
// on/off toggle (not real crypto) — TRACS compares it against ground-truth
// coalition internally to decide legitimacy, without ever exposing the
// coalition value itself. 'VALID' is the only value that should ever feed a
// reveal/auto-declare gate; 'INVALID'/'NO_REPLY' are display-only.
export function getIffStatus(unit, myCoalitionNum) {
  if (!unit?.srsCapable) return null
  if (unit.transponder?.mode4 !== true) return 'NO_REPLY'
  return unit.coalition === myCoalitionNum ? 'VALID' : 'INVALID'
}
