// Ephemeral (not persisted) active-conflicts state, written by StarsScope's
// compute loop and read independently by DatablockOverlay/AlertList — same
// "single computation owner writes, many components subscribe" pattern as
// useUnitsStore/useRunwaysStore.

import { create } from 'zustand'

export const useStcaStore = create((set) => ({
  conflicts: [], // [{ id, unitAId, unitBId, type: 'CA'|'MCI' }]

  setConflicts: (conflicts) => set({ conflicts }),
}))
