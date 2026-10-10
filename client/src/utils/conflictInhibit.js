// Per-track conflict alert inhibits. Each is stored on the track's flight
// plan when it has one (shared with every controller) and otherwise on the
// track itself for this scope only (moved onto the plan once one is bound).

/** Whether conflict alerts (CA K) are inhibited for a track. */
export function caDisabledFor(plan, localInhibited) {
  return plan ? !!plan.caDisabled : !!localInhibited
}

/** The intruder beacon code whose MCI alerts are suppressed (CA M), or ''. */
export function mciSuppressedFor(plan, localCode) {
  return (plan ? plan.mciSuppressedCode : localCode) || ''
}
