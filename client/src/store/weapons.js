import { create } from 'zustand'
import { syncStore } from '../utils/storeSync.js'

// Missile tracking (AIC/ABM) — mirrors store/units.js's shape/applyDelta
// pattern but deliberately without its bearing/track-smoothing logic: that
// exists to compute a stable heading from consecutive position samples for a
// long-lived aircraft, which has no equivalent use here — a missile's
// terminal-seconds flight has no consumer needing a smoothed track, and it's
// rendered as a plain dot (no heading-dependent symbol).
export const useWeaponsStore = create((set) => ({
  // Keyed by Olympus/Tacview weapon ID
  weapons: {},
  lastUpdateTime: 0,

  applyDelta: (delta) =>
    set((state) => {
      const next = { ...state.weapons }
      if (delta.updated) {
        for (const [id, weapon] of Object.entries(delta.updated)) {
          next[id] = { ...next[id], ...weapon }
        }
      }
      if (delta.removed) {
        for (const id of delta.removed) {
          delete next[id]
        }
      }
      return { weapons: next, lastUpdateTime: delta.time ?? Date.now() }
    }),

  clearWeapons: () => set({ weapons: {}, lastUpdateTime: 0 }),
}))

if (typeof window !== 'undefined') {
  syncStore(useWeaponsStore, 'tracs-weapons', (s) => ({ weapons: s.weapons, lastUpdateTime: s.lastUpdateTime }))
}
