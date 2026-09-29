import { create } from 'zustand'
import { syncStore } from '../utils/storeSync.js'

// Maps unitId (string) → side number (string, e.g. "211").
// Side numbers are carrier modex numbers assigned by CATCC when correlating
// an anonymous radar track to a known aircraft.
//
// pendingCodes: unitId → live squawk code, for an srsCapable unit that's
// squawking but hasn't matched a Status Board entry's assigned BCN yet — the
// STARS-LDB-style "reduced info instead of full anonymity" case. Written by
// the same StatusBoard.jsx sync effect that writes `correlations`, read only
// by CatccScope's datablock renderer.
export const useCorrelationStore = create((set) => ({
  correlations: {},
  pendingCodes: {},

  correlate: (unitId, sideNumber) =>
    set((s) => ({ correlations: { ...s.correlations, [String(unitId)]: sideNumber } })),

  setAll: (correlations) => set({ correlations }),
  setPendingCodes: (pendingCodes) => set({ pendingCodes }),

  reset: () => set({ correlations: {}, pendingCodes: {} }),
}))

syncStore(useCorrelationStore, 'tracs-correlations', (s) => ({ correlations: s.correlations }))
