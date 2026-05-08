// Incoming module-room event handlers.
// These apply received state to local stores — never re-broadcast.

import { useFlightPlansStore }  from '../store/flightPlans.js'
import { useAtcStore, HANDOFF_STATE, POINTOUT_STATE } from '../store/atc.js'
import { useStripsStore, STRIP_HIGHLIGHT } from '../store/strips.js'
import { useSessionStore } from '../store/session.js'
import { useControllersStore } from '../store/controllers.js'
import { applyStatusBoardUpdate } from '../store/statusBoard.js'

function getMyControllerId() {
  const positionName = useSessionStore.getState().positionName
  return useControllersStore.getState().registry[positionName]?.controllerId ?? null
}

export function handleModuleMessage(msg) {
  const { type, payload, module } = msg
  if (!type || !payload) return

  if (module === 'ATC') handleAtc(type, payload)
  if (module === 'CATCC') handleCatcc(type, payload)
}

function handleAtc(type, payload) {
  const fps  = useFlightPlansStore.getState()
  const atc  = useAtcStore.getState()
  const strips = useStripsStore.getState()

  switch (type) {
    case 'FLIGHT_PLAN_CREATE':
      fps.add(payload)
      if (strips.autoAddOnTrack) {
        // Don't auto-strip on remote creates — controller decides when to track
      }
      break

    case 'FLIGHT_PLAN_AMEND':
      fps.amend(payload.aid, payload)
      break

    case 'FLIGHT_PLAN_DELETE':
      fps.remove(payload.aid)
      break

    case 'TRACK_CLAIMED':
      atc.claimTrack(payload.unitId, payload.controllerId)
      if (strips.autoAddOnHandoff) {
        // Strip added when handoff is received, not when remote claims
      }
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
      if (isTarget && strips.autoAddOnHandoff) {
        const plan = Object.values(fps.plans).find((p) => String(p.unitId) === String(payload.unitId))
        if (plan) strips.addStrip(plan.aid, { highlight: STRIP_HIGHLIGHT.AUTO_ADDED })
      }
      break
    }

    case 'HANDOFF_ACCEPTED': {
      const myId = getMyControllerId()
      atc.claimTrack(payload.unitId, payload.toControllerId)
      atc.clearHandoff(payload.unitId)
      // Sender: sticky FDB + 5-second blink to confirm handoff was accepted
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

    case 'POINT_OUT_SENT':
      atc.setPointOut(payload.unitId, {
        state: POINTOUT_STATE.SENT,
        from:  payload.fromControllerId,
        to:    payload.toControllerId,
      })
      break

    case 'POINT_OUT_ACCEPTED':
      atc.clearPointOut(payload.unitId)
      break

    case 'POINT_OUT_REJECTED':
      atc.clearPointOut(payload.unitId)
      break

    case 'POINT_OUT_CONVERTED':
      atc.clearPointOut(payload.unitId)
      atc.claimTrack(payload.unitId, payload.toControllerId)
      break

    case 'STRIP_PASSED': {
      const myPosition = useSessionStore.getState().positionName
      if (payload.toPosition && payload.toPosition !== myPosition) break
      if (strips.ignoreStripPasses) break
      if (strips.autoAddOnStripPass) {
        strips.addStrip(payload.aid, {
          annotations: payload.annotations,
          highlight:   STRIP_HIGHLIGHT.AUTO_ADDED,
        })
      }
      break
    }
  }
}

function handleCatcc(type, payload) {
  switch (type) {
    case 'STATUS_BOARD_UPDATE':
      applyStatusBoardUpdate(payload)
      break
  }
}
