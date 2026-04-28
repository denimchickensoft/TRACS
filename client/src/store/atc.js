import { create } from 'zustand'

// Handoff states for a given unit
export const HANDOFF_STATE = {
  NONE: 'NONE',
  INITIATED: 'INITIATED',   // we sent a handoff, awaiting acceptance
  RECEIVING: 'RECEIVING',   // we are the target, awaiting our action
}

// Point out states
export const POINTOUT_STATE = {
  NONE: 'NONE',
  SENT: 'SENT',
  RECEIVING: 'RECEIVING',
}

export const useAtcStore = create((set) => ({
  // Ownership: unitId → positionName
  ownership: {},

  // Handoffs: unitId → { state, from, to }
  handoffs: {},

  // Point outs: unitId → { state, from, to }
  pointOuts: {},

  // Per-unit scratchpad overrides (two fields per STARS model)
  scratchpads: {},    // unitId → { sp1: '', sp2: '' }

  // Callsign overrides: unitId → string (controller-assigned local label)
  callsignOverrides: {},

  // Per-unit leader line direction: unitId → '1'–'9' (numpad direction code)
  leaderDirs: {},

  // Quick look active unit IDs
  quickLook: new Set(),

  claimTrack: (unitId, positionName) =>
    set((state) => ({
      ownership: { ...state.ownership, [unitId]: positionName },
    })),

  dropTrack: (unitId) =>
    set((state) => {
      const next = { ...state.ownership }
      delete next[unitId]
      return { ownership: next }
    }),

  setHandoff: (unitId, handoff) =>
    set((state) => ({
      handoffs: { ...state.handoffs, [unitId]: handoff },
    })),

  clearHandoff: (unitId) =>
    set((state) => {
      const next = { ...state.handoffs }
      delete next[unitId]
      return { handoffs: next }
    }),

  setPointOut: (unitId, pointOut) =>
    set((state) => ({
      pointOuts: { ...state.pointOuts, [unitId]: pointOut },
    })),

  clearPointOut: (unitId) =>
    set((state) => {
      const next = { ...state.pointOuts }
      delete next[unitId]
      return { pointOuts: next }
    }),

  setScratchpad: (unitId, field, value) =>
    set((state) => ({
      scratchpads: {
        ...state.scratchpads,
        [unitId]: { ...state.scratchpads[unitId], [field]: value },
      },
    })),

  setCallsignOverride: (unitId, callsign) =>
    set((state) => ({
      callsignOverrides: { ...state.callsignOverrides, [unitId]: callsign },
    })),

  clearCallsignOverride: (unitId) =>
    set((state) => {
      const next = { ...state.callsignOverrides }
      delete next[unitId]
      return { callsignOverrides: next }
    }),

  setLeaderDir: (unitId, dir) =>
    set((state) => ({
      leaderDirs: { ...state.leaderDirs, [unitId]: dir },
    })),

  clearLeaderDir: (unitId) =>
    set((state) => {
      const next = { ...state.leaderDirs }
      delete next[unitId]
      return { leaderDirs: next }
    }),

  toggleQuickLook: (unitId) =>
    set((state) => {
      const next = new Set(state.quickLook)
      if (next.has(unitId)) next.delete(unitId)
      else next.add(unitId)
      return { quickLook: next }
    }),

  reset: () =>
    set({ ownership: {}, handoffs: {}, pointOuts: {}, scratchpads: {}, callsignOverrides: {}, leaderDirs: {}, quickLook: new Set() }),
}))
