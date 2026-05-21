import { useAtcStore }            from '../store/atc.js'
import { useStripsStore }         from '../store/strips.js'
import { useFlightPlansStore }    from '../store/flightPlans.js'
import { useStatusBoardStore, renameStatusBoardEntry } from '../store/statusBoard.js'
import { useUnitsStore }          from '../store/units.js'
import { resolveCallsign, resolveOriginalCallsign } from './callsign.js'

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

  useStripsStore.getState().renameAid(unitId, targetCallsign)
  useFlightPlansStore.getState().renameAid(unitId, targetCallsign, oldCallsign)
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

  useStripsStore.getState().renameAid(unitId, targetCallsign)
  useFlightPlansStore.getState().renameAid(unitId, targetCallsign, oldCallsign)
  renameStatusBoardEntry(unitId, targetCallsign)
}
