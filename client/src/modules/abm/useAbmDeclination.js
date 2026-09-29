import { useMemo } from 'react'
import { useSessionStore } from '../../store/session.js'
import { useDisplayStore } from '../../store/display.js'
import { computeMagvar } from '../../utils/magvar.js'
import { findCoalitionBullseye } from '../../utils/tacticalHelpers.js'

// Same bullseye-anchored declination AbmScope.jsx's map rotation uses
// (computeMagvar(bullseyeLat, bullseyeLng, missionDate), where the bullseye
// is the window's `.be` override if set, else the mission bullseye) — shared
// here so
// Drawings.jsx's magnetic-heading param editing always agrees with what's
// actually drawn on the scope, rather than a second independently-computed
// value that could drift from it. AbmScope.jsx keeps its own inline copy of
// this (predates this hook) rather than being refactored to use it, to
// avoid touching proven map-rotation code for an unrelated change.
export function useAbmDeclination(windowId = 'abm-main') {
  const mission     = useSessionStore(s => s.mission)
  const coalition   = useSessionStore(s => s.coalition)
  const bullseyes   = useSessionStore(s => s.bullseyes)
  const missionDate = mission?.mission?.dateAndTime?.date ?? null
  const bullseyeOverride = useDisplayStore(s => s.windows[windowId]?.bullseyeOverride ?? null)

  const bullseyeEntry = useMemo(() => findCoalitionBullseye(bullseyes, coalition), [bullseyes, coalition])

  return computeMagvar(
    bullseyeOverride?.lat ?? bullseyeEntry?.latitude  ?? 0,
    bullseyeOverride?.lng ?? bullseyeEntry?.longitude ?? 0,
    missionDate,
  )
}
