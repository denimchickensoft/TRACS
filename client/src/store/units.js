import { create } from 'zustand'

export const useUnitsStore = create((set) => ({
  // Keyed by Olympus unit ID
  units: {},
  lastUpdateTime: 0,

  applyDelta: (delta) =>
    set((state) => {
      const next = { ...state.units }
      if (delta.updated) {
        for (const [id, unit] of Object.entries(delta.updated)) {
          next[id] = { ...next[id], ...unit }
        }
      }
      if (delta.removed) {
        for (const id of delta.removed) {
          delete next[id]
        }
      }
      return { units: next, lastUpdateTime: delta.time ?? Date.now() }
    }),

  clearUnits: () => set({ units: {}, lastUpdateTime: 0 }),
}))
