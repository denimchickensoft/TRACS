import { useAtcStore }            from '../store/atc.js'
import { useStripsStore }         from '../store/strips.js'
import { useFlightPlansStore }    from '../store/flightPlans.js'
import { useStatusBoardStore, renameStatusBoardEntry } from '../store/statusBoard.js'
import { useUnitsStore }          from '../store/units.js'
import { resolveCallsign, resolveOriginalCallsign, findFlightPlanAid } from './callsign.js'

// A rename changes only the callsign shown: a flight plan keeps its AID
// (a mission plan stays RMD51 under any name), and a strip keeps its plan's
// AID or, with no plan, follows the new callsign.
function syncStrips(unitId, unit) {
  if (!unit) return
  useStripsStore.getState().renameAid(unitId, findFlightPlanAid(unit, useFlightPlansStore.getState().plans))
}

// Apply a callsign rename or reset locally (no broadcast).
// Status board update is included so it auto-broadcasts STATUS_BOARD_UPDATE on the CATCC module room.
// Returns { oldCallsign } so callers can include it in the WebRTC payload.
export function applyCallsignChange(unitId, unit, newCallsign) {
  const oldCallsign    = resolveCallsign(unit)
  const targetCallsign = newCallsign ?? resolveOriginalCallsign(unit)

  if (newCallsign) {
    useAtcStore.getState().setCallsignOverride(String(unitId), newCallsign)
  } else {
    useAtcStore.getState().clearCallsignOverride(String(unitId))
  }

  syncStrips(unitId, unit)
  useStatusBoardStore.getState().renameEntry(unitId, targetCallsign)

  return { oldCallsign }
}

// Apply an incoming CALLSIGN_RENAME session-room event without re-broadcasting.
export function applyCallsignRenameRemote({ unitId, oldCallsign, newCallsign }) {
  const unit = useUnitsStore.getState().units[String(unitId)]

  if (newCallsign) {
    useAtcStore.getState().setCallsignOverride(String(unitId), newCallsign)
  } else {
    useAtcStore.getState().clearCallsignOverride(String(unitId))
  }

  const targetCallsign = newCallsign ?? (unit ? resolveOriginalCallsign(unit) : oldCallsign)

  syncStrips(unitId, unit)
  renameStatusBoardEntry(unitId, targetCallsign)
}
