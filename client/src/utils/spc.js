import { hasLiveSquawk, normalizeCode } from './transponder.js'

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

// How long a new special condition (or MSAW) alert sounds unless acknowledged.
export const ALERT_AUDIO_MS = 5000

/** The SPC tag a unit is squawking right now (SRS-fielded, live transponder), or null. */
function squawkedSpc(unit) {
  if (!unit?.srsCapable || !hasLiveSquawk(unit)) return null
  return spcForCode(normalizeCode(unit.transponder.mode3))
}

/**
 * The alerts whose track is still squawking the code, i.e. the tags to show.
 * An entry outlives its squawk (so squawking off and back on doesn't sound
 * again), but the tag is only shown while the code is squawked.
 */
export function shownSpcAlerts(spc, units) {
  const out = {}
  for (const [uid, a] of Object.entries(spc)) {
    if (squawkedSpc(units?.[uid]) === a.code) out[uid] = a
  }
  return out
}

/**
 * The next special-condition alert map ({ [uid]: { code, acked, soundEnd } })
 * for the visible `units`. An entry is armed the first time a track squawks
 * an SPC code and stays until the track goes away (squawking off doesn't
 * re-arm it); squawking a different SPC code re-arms it with the new tag.
 */
export function trackSpcAlerts(prevSpc, units, now) {
  const spc = {}
  for (const [id, unit] of Object.entries(units ?? {})) {
    const uid = String(id)
    const spcCode = squawkedSpc(unit)
    const prev = prevSpc[uid]
    if (prev && (!spcCode || prev.code === spcCode)) spc[uid] = prev
    else if (spcCode) spc[uid] = { code: spcCode, acked: false, soundEnd: now + ALERT_AUDIO_MS }
  }
  return spc
}

/** True while any special-condition alert is unacknowledged and still in its tone window. */
export function spcSounding(spc, now) {
  return Object.values(spc).some((a) => !a.acked && now < a.soundEnd)
}
