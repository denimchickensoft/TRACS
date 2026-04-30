// Incoming module-room event handlers.
// These apply received state to local stores — never re-broadcast.

import { useFlightPlansStore }  from '../store/flightPlans.js'
import { useAtcStore, HANDOFF_STATE, POINTOUT_STATE } from '../store/atc.js'
import { useStripsStore, STRIP_HIGHLIGHT } from '../store/strips.js'
import { useSessionStore } from '../store/session.js'
import { applyStatusBoardUpdate } from '../store/statusBoard.js'

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
      atc.claimTrack(payload.unitId, payload.position)
      if (strips.autoAddOnHandoff) {
        // Strip added when handoff is received, not when remote claims
      }
      break

    case 'TRACK_DROPPED':
      atc.dropTrack(payload.unitId)
      break

    case 'HANDOFF_INITIATED': {
      const myPosition = useSessionStore.getState().positionName
      const isTarget   = payload.toPosition === myPosition
      atc.setHandoff(payload.unitId, {
        state: isTarget ? HANDOFF_STATE.RECEIVING : HANDOFF_STATE.INITIATED,
        from:  payload.fromPosition,
        to:    payload.toPosition,
      })
      if (isTarget && strips.autoAddOnHandoff) {
        const plan = Object.values(fps.plans).find((p) => String(p.unitId) === String(payload.unitId))
        if (plan) strips.addStrip(plan.aid, { highlight: STRIP_HIGHLIGHT.AUTO_ADDED })
      }
      break
    }

    case 'HANDOFF_ACCEPTED':
      atc.claimTrack(payload.unitId, payload.toPosition)
      atc.clearHandoff(payload.unitId)
      break

    case 'HANDOFF_REJECTED':
      atc.clearHandoff(payload.unitId)
      break

    case 'HANDOFF_RECALLED':
      atc.clearHandoff(payload.unitId)
      break

    case 'HANDOFF_REDIRECTED':
      atc.setHandoff(payload.unitId, {
        state: HANDOFF_STATE.INITIATED,
        from:  payload.fromPosition,
        to:    payload.toPosition,
      })
      break

    case 'POINT_OUT_SENT':
      atc.setPointOut(payload.unitId, {
        state: POINTOUT_STATE.SENT,
        from:  payload.fromPosition,
        to:    payload.toPosition,
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
      atc.claimTrack(payload.unitId, payload.toPosition)
      break

    case 'STRIP_PASSED':
      if (strips.autoAddOnStripPass) {
        strips.addStrip(payload.aid, {
          annotations: payload.annotations,
          highlight:   STRIP_HIGHLIGHT.AUTO_ADDED,
        })
      }
      break
  }
}

function handleCatcc(type, payload) {
  switch (type) {
    case 'STATUS_BOARD_UPDATE':
      applyStatusBoardUpdate(payload)
      break
  }
}
