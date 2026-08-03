import { useMemo } from 'react'
import { useSessionStore } from '../../store/session.js'
import { computeMagvar } from '../../utils/magvar.js'

// Same bullseye-anchored declination AbmScope.jsx's map rotation uses
// (computeMagvar(bullseyeLat, bullseyeLng, missionDate)) — shared here so
// Drawings.jsx's magnetic-heading param editing always agrees with what's
// actually drawn on the scope, rather than a second independently-computed
// value that could drift from it. AbmScope.jsx keeps its own inline copy of
// this (predates this hook) rather than being refactored to use it, to
// avoid touching proven map-rotation code for an unrelated change.
export function useAbmDeclination() {
  const mission     = useSessionStore(s => s.mission)
  const coalition   = useSessionStore(s => s.coalition)
  const bullseyes   = useSessionStore(s => s.bullseyes)
  const missionDate = mission?.mission?.dateAndTime?.date ?? null

  const bullseyeEntry = useMemo(() => {
    if (!bullseyes?.bullseyes) return null
    const coalStr = coalition === 'red' ? 'red' : 'blue'
    return Object.values(bullseyes.bullseyes).find(b => b.coalition === coalStr)
        ?? Object.values(bullseyes.bullseyes)[0]
        ?? null
  }, [bullseyes, coalition])

  return computeMagvar(bullseyeEntry?.latitude ?? 0, bullseyeEntry?.longitude ?? 0, missionDate)
}
