import { create } from 'zustand'
import { createBroadcastHook } from '../utils/broadcastRegistry.js'

// ROE is genuine cross-module state: AIC and ABM controllers share one
// FREE/TIGHT/HOLD value. Unlike declarations/autoDeclareMode (module-room,
// see createDeclarationStore.js), ROE broadcasts on the session room via
// webrtc/client.js's registerRoeBroadcast wiring — reaching every connected
// controller regardless of active module, same as CALLSIGN_RENAME.
export const ROE_STATE = {
  FREE:  'FREE',
  TIGHT: 'TIGHT',
  HOLD:  'HOLD',
}

export const ROE_DISPLAY = {
  [ROE_STATE.FREE]:  'WEAPONS FREE',
  [ROE_STATE.TIGHT]: 'WEAPONS TIGHT',
  [ROE_STATE.HOLD]:  'WEAPONS HOLD',
}

const { register: registerRoeBroadcast, broadcast } = createBroadcastHook()
export { registerRoeBroadcast }

export const useRoeStore = create((set) => ({
  roe: null, // ROE_STATE | null

  setRoe: (roe) => {
    set({ roe })
    broadcast('ROE_SET', { roe })
  },
}))

// Remote ROE_SET / STATE_DUMP application — no re-broadcast.
export function applyRoe(roe) {
  useRoeStore.setState({ roe })
}
