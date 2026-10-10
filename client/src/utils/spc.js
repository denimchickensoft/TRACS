// Special condition codes (SPC): beacon codes that raise a datablock alert
// on any scope that sees the track, shown as their two-letter abbreviation.
const SPCS = {
  '7400': 'LL', // Lost link
  '7500': 'HJ', // Hijack / unlawful interference
  '7600': 'RF', // Radio failure
  '7700': 'EM', // Emergency
  '7777': 'MI', // Military interceptor operations
}

const SPC_STRINGS = new Set(Object.values(SPCS))

/** The SPC abbreviation for a squawk (number or string), or null. */
export function spcForCode(mode3) {
  if (mode3 == null || mode3 === '') return null
  return SPCS[String(mode3).padStart(4, '0')] ?? null
}

/** True when `s` is one of the SPC abbreviations (EM, HJ, RF, LL, MI). */
export function isSpcString(s) {
  return SPC_STRINGS.has(s)
}
