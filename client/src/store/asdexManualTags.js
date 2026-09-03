import { create } from 'zustand'
import { syncStore } from '../utils/storeSync.js'

// ASDE-X-local manual tagging (CRC ASDE-X: "type the Target's aircraft ID,
// then left-click the unknown Target"). Deliberately NOT merged into
// store/association.js for v1 — see
// resources/specs/transponder-correlation-spec.md §5. TRACS's version isn't
// a guess like CRC's: the typed ID is checked against Olympus's real
// ground-truth callsign before a tag is ever recorded here, so every entry
// in this store is already known-correct.
//
// Future integration point (not built yet): an aircraft tagged here that
// later becomes STARS-visible could auto-associate on STARS via this same
// tag — see associationEngine.js's matching comment.
export const useAsdexManualTagsStore = create((set) => ({
  tagged: {}, // unitId (string) -> true

  tag: (unitId) =>
    set((s) => ({ tagged: { ...s.tagged, [String(unitId)]: true } })),

  untag: (unitId) =>
    set((s) => {
      const next = { ...s.tagged }
      delete next[String(unitId)]
      return { tagged: next }
    }),

  reset: () => set({ tagged: {} }),
}))

syncStore(useAsdexManualTagsStore, 'tracs-asdex-manual-tags', (s) => ({ tagged: s.tagged }))
