import { create } from 'zustand'

// Maps unitId (string) → side number (string, e.g. "211").
// Side numbers are carrier modex numbers assigned by CATCC when correlating
// an anonymous radar track to a known aircraft.
export const useCorrelationStore = create((set) => ({
  correlations: {},

  correlate: (unitId, sideNumber) =>
    set((s) => ({ correlations: { ...s.correlations, [String(unitId)]: sideNumber } })),

  uncorrelate: (unitId) =>
    set((s) => {
      const next = { ...s.correlations }
      delete next[String(unitId)]
      return { correlations: next }
    }),

  setAll: (correlations) => set({ correlations }),

  reset: () => set({ correlations: {} }),
}))
