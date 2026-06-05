import { create } from 'zustand'
import { syncStore } from '../utils/storeSync.js'

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

if (typeof window !== 'undefined') {
  syncStore(useUnitsStore, 'tracs-units', (s) => ({ units: s.units, lastUpdateTime: s.lastUpdateTime }))
}
