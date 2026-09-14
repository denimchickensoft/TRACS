// Incoming module-room event handlers.
// These apply received state to local stores — never re-broadcast.

import { useFlightPlansStore }  from '../store/flightPlans.js'
import { useAtcStore, HANDOFF_STATE, POINTOUT_STATE } from '../store/atc.js'
import { useStripsStore, STRIP_HIGHLIGHT } from '../store/strips.js'
import { useSessionStore } from '../store/session.js'
import { useControllersStore } from '../store/controllers.js'
import { applyStatusBoardUpdate } from '../store/statusBoard.js'
import { applyAicDeclaration, applyAicDeclarationsReset, applyAicAutoDeclareMode } from '../store/aic.js'
import { applyAbmDeclaration, applyAbmDeclarationsReset, applyAbmAutoDeclareMode } from '../store/abm.js'
import { applyAbmMissionIffSet, applyAbmMissionManualFlightSet } from '../store/abmMission.js'

function getMyControllerId() {
  const positionName = useSessionStore.getState().positionName
  return useControllersStore.getState().registry[positionName]?.controllerId ?? null
}

export function handleModuleMessage(msg) {
  const { type, payload, module, fromPosition, timestamp } = msg
  if (!type || !payload) return

  if (type === 'CONTROLLER_MESSAGE') {
    useSessionStore.getState().addControllerMessage({
      from:        fromPosition,
      fromPosition,
      text:        payload.text,
      broadcast:   false,
      toPosition:  null,
      timestamp:   timestamp ?? Date.now(),
    })
    return
  }

  if (module === 'ATC')   handleAtc(type, payload)
  if (module === 'CATCC') handleCatcc(type, payload)
  if (module === 'AIC')   handleAic(type, payload)
  if (module === 'ABM')   handleAbm(type, payload)
}

// ── Shared track/handoff/point-out handler (ATC + CATCC) ─────────────────────
function handleTrackAndHandoff(type, payload) {
  const atc = useAtcStore.getState()
  switch (type) {
    case 'TRACK_CLAIMED':
      atc.claimTrack(payload.unitId, payload.controllerId)
      break
    case 'TRACK_DROPPED':
      atc.dropTrack(payload.unitId)
      break
    case 'HANDOFF_INITIATED': {
      const myControllerId = getMyControllerId()
      const isTarget       = payload.toControllerId === myControllerId
      atc.setHandoff(payload.unitId, {
        state: isTarget ? HANDOFF_STATE.RECEIVING : HANDOFF_STATE.INITIATED,
        from:  payload.fromControllerId,
        to:    payload.toControllerId,
      })
      break
    }
    case 'HANDOFF_ACCEPTED': {
      const myId = getMyControllerId()
      atc.claimTrack(payload.unitId, payload.toControllerId)
      atc.clearHandoff(payload.unitId)
      if (payload.fromControllerId === myId) {
        atc.setDisplayFdb(payload.unitId)
        atc.setBlinkTrack(payload.unitId)
      }
      break
    }
    case 'HANDOFF_REJECTED':
      atc.clearHandoff(payload.unitId)
      break
    case 'HANDOFF_RECALLED':
      atc.clearHandoff(payload.unitId)
      break
    case 'HANDOFF_REDIRECTED':
      atc.setHandoff(payload.unitId, {
        state: HANDOFF_STATE.INITIATED,
        from:  payload.fromControllerId,
        to:    payload.toControllerId,
      })
      break
    case 'POINT_OUT_SENT': {
      const myControllerId = getMyControllerId()
      const isTarget = payload.toControllerId === myControllerId
      atc.setPointOut(payload.unitId, {
        state: isTarget ? POINTOUT_STATE.RECEIVING : POINTOUT_STATE.SENT,
        from:  payload.fromControllerId,
        to:    payload.toControllerId,
      })
      break
    }
    case 'POINT_OUT_RECALLED':
      atc.clearPointOut(payload.unitId)
      break
    case 'POINT_OUT_ACCEPTED':
      atc.clearPointOut(payload.unitId)
      break
    case 'POINT_OUT_REJECTED': {
      const myId = getMyControllerId()
      if (payload.fromControllerId === myId) {
        // I'm the original sender — hold REJECTED state so UN indicator is shown
        atc.setPointOut(payload.unitId, {
          state: POINTOUT_STATE.REJECTED,
          from:  payload.fromControllerId,
          to:    payload.toControllerId,
        })
      } else {
        atc.clearPointOut(payload.unitId)
      }
      break
    }
    case 'POINT_OUT_CONVERTED':
      atc.clearPointOut(payload.unitId)
      atc.claimTrack(payload.unitId, payload.toControllerId)
      break
  }
}

function handleAtc(type, payload) {
  const fps    = useFlightPlansStore.getState()
  const strips = useStripsStore.getState()

  handleTrackAndHandoff(type, payload)

  switch (type) {
    case 'CONFLICT_ACK':
      useAtcStore.getState().ackConflict(payload.pairId)
      break
    case 'FLIGHT_PLAN_CREATE':
      fps.add(payload)
      break
    case 'FLIGHT_PLAN_AMEND':
      fps.amend(payload.aid, payload)
      break
    case 'FLIGHT_PLAN_DELETE':
      fps.remove(payload.aid)
      break
    case 'HANDOFF_INITIATED': {
      const myControllerId = getMyControllerId()
      if (payload.toControllerId === myControllerId && strips.autoAddOnHandoff) {
        const plan = Object.values(fps.plans).find((p) => String(p.unitId) === String(payload.unitId))
        if (plan) strips.addStrip(plan.aid, { highlight: STRIP_HIGHLIGHT.AUTO_ADDED, unitId: payload.unitId ?? null })
      }
      break
    }
    case 'STRIP_PASSED': {
      const myPosition = useSessionStore.getState().positionName
      if (payload.toPosition && payload.toPosition !== myPosition) break
      if (strips.ignoreStripPasses) break
      if (strips.autoAddOnStripPass) {
        strips.addStrip(payload.aid, {
          annotations: payload.annotations,
          highlight:   STRIP_HIGHLIGHT.AUTO_ADDED,
          unitId:      payload.unitId ?? null,
        })
      }
      break
    }
  }
}

function handleCatcc(type, payload) {
  handleTrackAndHandoff(type, payload)
  if (type === 'STATUS_BOARD_UPDATE') applyStatusBoardUpdate(payload)
}

function handleAic(type, payload) {
  switch (type) {
    case 'DECLARATION_SET':
      applyAicDeclaration(payload.unitId, payload.declaration)
      break
    case 'DECLARATIONS_RESET':
      applyAicDeclarationsReset()
      break
    case 'AUTO_DECLARE_MODE_SET':
      applyAicAutoDeclareMode(payload.mode)
      break
  }
}

// ABM keeps its own independent declaration state — NOT synced with AIC's
// (deferred cross-module sharing decision, see abm-spec.md §1.2).
function handleAbm(type, payload) {
  switch (type) {
    case 'DECLARATION_SET':
      applyAbmDeclaration(payload.unitId, payload.declaration)
      break
    case 'DECLARATIONS_RESET':
      applyAbmDeclarationsReset()
      break
    case 'AUTO_DECLARE_MODE_SET':
      applyAbmAutoDeclareMode(payload.mode)
      break
    case 'FRAG_IFF_SET':
      applyAbmMissionIffSet(payload)
      break
    case 'FRAG_MANUAL_FLIGHT_SET':
      applyAbmMissionManualFlightSet(payload)
      break
  }
}
