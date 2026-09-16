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

// Pure — filters a STATE_DUMP payload's ownership/handoffs/pointOuts down to
// controllerIds actually present in the session. Used by applyAtcDump/
// applyCatccDump (client/src/webrtc/client.js) to compute the next value
// *before* touching the store, so the whole transition can land in one set()
// via applyStateDump() below instead of reset()-then-per-item-replay (which
// exposes an intermediate all-empty tick to every live subscriber — see
// feedback_webrtc_relay_sync_invariants memory, invariant #1).
export function filterAtcDumpPayload(payload, activeIds) {
  const ownership = {}
  for (const [uid, cid] of Object.entries(payload.trackOwnership ?? {}))
    if (activeIds.has(cid)) ownership[uid] = cid
  const handoffs = {}
  for (const [uid, ho] of Object.entries(payload.handoffs ?? {}))
    if (activeIds.has(ho.from) && activeIds.has(ho.to)) handoffs[uid] = ho
  const pointOuts = {}
  for (const [uid, po] of Object.entries(payload.pointOuts ?? {}))
    if (activeIds.has(po.from) && activeIds.has(po.to)) pointOuts[uid] = po
  return { ownership, handoffs, pointOuts }
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

  // Real transponder IDENT (status 2) — latched, same blink treatment as a
  // handoff, cleared only when the controller slews the contact (not on a
  // timer, not just because status reverts). unitId → true. See
  // resources/specs/transponder-correlation-spec.md §4.
  identUnacked: {},

  // Acknowledged conflict-alert pairs: pairId → true. Pruned each STCA
  // compute cycle (StarsScope.jsx) when a pairId drops out of the active
  // conflict set, so a resolved-then-recurring conflict re-alerts.
  conflictAcks: {},

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

  markIdent: (unitId) =>
    set((state) => ({ identUnacked: { ...state.identUnacked, [unitId]: true } })),

  clearIdent: (unitId) =>
    set((state) => {
      const next = { ...state.identUnacked }
      delete next[unitId]
      return { identUnacked: next }
    }),

  ackConflict: (pairId) =>
    set((state) => ({
      conflictAcks: { ...state.conflictAcks, [pairId]: true },
    })),

  pruneConflictAcks: (activeIds) =>
    set((state) => {
      const activeSet = new Set(activeIds)
      const next = {}
      for (const id of Object.keys(state.conflictAcks)) {
        if (activeSet.has(id)) next[id] = true
      }
      return { conflictAcks: next }
    }),

  reset: () =>
    set({ ownership: {}, handoffs: {}, pointOuts: {}, scratchpads: {}, callsignOverrides: {}, quickLook: new Set(), displayFdb: {}, blinkTracks: {}, identUnacked: {}, conflictAcks: {} }),

  // Atomically replace ownership/handoffs/pointOuts from an authoritative
  // STATE_DUMP in a single set() — unlike reset() followed by a
  // claimTrack/setHandoff/setPointOut replay, this never exposes an
  // intermediate "everything wiped" tick to subscribers (DatablockOverlay's
  // live ownership read, associationEngine's sticky-while-owned check). See
  // commit 5b7ae01 (mergeClientList) for the same principle applied to
  // clientList. callsignOverrides is deliberately NOT cleared here —
  // applyDump() (client.js) applies payload.callsignOverrides itself,
  // unconditionally, for every module, right after the per-module dump
  // function returns.
  applyStateDump: (ownership, handoffs, pointOuts) =>
    set({
      ownership, handoffs, pointOuts,
      scratchpads: {}, quickLook: new Set(), displayFdb: {},
      blinkTracks: {}, identUnacked: {}, conflictAcks: {},
    }),
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
