import { create } from 'zustand'
import { syncStore } from '../utils/storeSync.js'

// ASDE-X-local scratchpads (CRC ASDE-X fields J/K, set via MF Y / MF H).
// Deliberately separate from STARS' scratchpads in store/atc.js — tower and
// TRACON annotations don't share a field. Same cross-window-only sync as
// store/asdexManualTags.js; not shared with other controllers.
export const useAsdexScratchpadsStore = create((set) => ({
  pads: {}, // unitId (string) -> { sp1, sp2 }

  // Empty value clears that field.
  set: (unitId, field, value) =>
    set((s) => {
      const id  = String(unitId)
      const cur = { ...(s.pads[id] ?? {}), [field]: value }
      const next = { ...s.pads }
      if (!cur.sp1 && !cur.sp2) delete next[id]
      else next[id] = cur
      return { pads: next }
    }),

  reset: () => set({ pads: {} }),
}))

syncStore(useAsdexScratchpadsStore, 'tracs-asdex-scratchpads', (s) => ({ pads: s.pads }))
