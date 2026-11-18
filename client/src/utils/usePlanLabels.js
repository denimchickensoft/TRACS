import { useShallow } from 'zustand/react/shallow'
import { useAssociationStore } from '../store/association.js'
import { useUnitsStore } from '../store/units.js'
import { useAtcStore } from '../store/atc.js'
import { useSessionStore } from '../store/session.js'
import { planLabels } from './callsign.js'

/**
 * { [aid]: callsign } for every flight plan associated with a live contact:
 * what the strip and the STARS lists show instead of the plan's own AID (a
 * mission plan RMD51 flown as MALLET31). Re-renders only when a label
 * changes, not on every unit update.
 */
export function usePlanLabels() {
  const associated = useAssociationStore(useShallow((s) => s.associated))
  // resolveCallsign reads these; subscribe so a rename or the toggle shows.
  useAtcStore((s) => s.callsignOverrides)
  useSessionStore((s) => s.useDcsNames)
  return useUnitsStore(useShallow((s) => planLabels(associated, s.units)))
}
