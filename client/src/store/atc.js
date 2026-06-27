import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

// Handoff states for a given unit
export const HANDOFF_STATE = {
  NONE: 'NONE',
  INITIATED: 'INITIATED',   // we sent a handoff, awaiting acceptance
  RECEIVING: 'RECEIVING',   // we are the target, awaiting our action
}

// Point out states
export const POINTOUT_STATE = {
  NONE:      'NONE',
  SENT:      'SENT',
  RECEIVING: 'RECEIVING',
  REJECTED:  'REJECTED',   // sender sees UN indicator until they dismiss it
}

export const useAtcStore = create(
  persist(
    (set) => ({
  // Ownership: unitId → controllerId (e.g. "1T")
  ownership: {},

  // Handoffs: unitId → { state, from: controllerId, to: controllerId }
  handoffs: {},

  // Point outs: unitId → { state, from: controllerId, to: controllerId }
  pointOuts: {},

  // Per-unit scratchpad overrides (two fields per STARS model)
  scratchpads: {},    // unitId → { sp1: '', sp2: '' }

  // Callsign overrides: unitId → string (controller-assigned local label)
  callsignOverrides: {},


  // Quick look active unit IDs
  quickLook: new Set(),

  // Sticky FDB after outbound handoff acceptance: unitId → true
  displayFdb: {},

  // Blink-white after accepting a handoff: unitId → expiresAt (ms timestamp)
  blinkTracks: {},

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

  toggleQuickLook: (unitId) =>
    set((state) => {
      const next = new Set(state.quickLook)
      if (next.has(unitId)) next.delete(unitId)
      else next.add(unitId)
      return { quickLook: next }
    }),

  setDisplayFdb: (unitId) =>
    set((state) => ({ displayFdb: { ...state.displayFdb, [unitId]: true } })),

  clearDisplayFdb: (unitId) =>
    set((state) => {
      const next = { ...state.displayFdb }
      delete next[unitId]
      return { displayFdb: next }
    }),

  setBlinkTrack: (unitId) =>
    set((state) => ({
      blinkTracks: { ...state.blinkTracks, [unitId]: Date.now() + 5000 },
    })),

  clearBlinkTrack: (unitId) =>
    set((state) => {
      const next = { ...state.blinkTracks }
      delete next[unitId]
      return { blinkTracks: next }
    }),

  reset: () =>
    set({ ownership: {}, handoffs: {}, pointOuts: {}, scratchpads: {}, callsignOverrides: {}, quickLook: new Set(), displayFdb: {}, blinkTracks: {} }),
    }),
    {
      name: 'tracs.atc',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({
        ownership: state.ownership,
        handoffs:  state.handoffs,
        pointOuts: state.pointOuts,
      }),
    }
  )
)
