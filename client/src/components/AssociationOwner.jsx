import { useEffect, useRef } from 'react'
import { useSessionStore }     from '../store/session'
import { useUnitsStore }       from '../store/units'
import { useFlightPlansStore } from '../store/flightPlans'
import { useAssociationStore } from '../store/association'
import { useAtcStore }         from '../store/atc.js'
import { computeAssociations } from '../modules/atc/shared/associationEngine.js'
import { dcsUnitIdReliable }   from '../utils/callsign.js'

// Renders nothing. Owns the two computations that watch every unit update:
// transponder-based association and IDENT onset detection. They live in
// their own component (always mounted by App, whichever module or screen is
// active) so that the units subscription re-renders only this, not App and
// the whole tree under it.
export function AssociationOwner() {
  // ── Transponder-based association — single compute owner ─────────────
  // Neither units.js nor flightPlans.js needs to know association exists —
  // this is the only place they're read together.
  const unitsForAssoc      = useUnitsStore((s) => s.units)
  const plansForAssoc      = useFlightPlansStore((s) => s.plans)
  const ownershipForAssoc  = useAtcStore((s) => s.ownership)
  const sourceTypeForAssoc = useSessionStore((s) => s.sourceType)
  useEffect(() => {
    const previous = useAssociationStore.getState().associated
    const next = computeAssociations({
      units: unitsForAssoc, flightPlans: plansForAssoc, ownership: ownershipForAssoc, previousAssociated: previous,
      dcsUnitIdReliable: dcsUnitIdReliable(),
    })
    useAssociationStore.getState().setAssociated(next)
  }, [unitsForAssoc, plansForAssoc, ownershipForAssoc, sourceTypeForAssoc])

  // ── IDENT onset detection ─────────────────────────────────────────────
  // Latches identUnacked on the edge (status becomes 2) — same blink
  // treatment as a handoff, cleared only by slewing the contact (see
  // StarsScope.jsx's bare-slew handler and dispatch call), not by a timer
  // and not just because status reverts.
  const prevIdentStatusRef = useRef({})
  useEffect(() => {
    const prev = prevIdentStatusRef.current
    const nextStatus = {}
    for (const [uid, unit] of Object.entries(unitsForAssoc)) {
      const status = unit.transponder?.status
      if (status === 2 && prev[uid] !== 2) useAtcStore.getState().markIdent(uid)
      if (status != null) nextStatus[uid] = status
    }
    prevIdentStatusRef.current = nextStatus
  }, [unitsForAssoc])

  return null
}
