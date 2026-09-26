import { create } from 'zustand'
import { syncStore } from '../utils/storeSync.js'

// Sticky per-unit transponder-based association state. Maps unitId (string) →
// the matched flight plan's AID (string, truthy) once a unit's live squawk +
// ground-truth callsign have matched it. Consumers only ever check
// truthiness, never a specific value. Written exclusively by
// modules/atc/shared/associationEngine.js's compute owner (mounted once in
// App.jsx) — same "single computation owner writes, many components
// subscribe" pattern as store/stca.js. Dumb store: no logic here.
export const useAssociationStore = create((set) => ({
  associated: {},

  setAssociated: (associated) => set({ associated }),

  reset: () => set({ associated: {} }),
}))

syncStore(useAssociationStore, 'tracs-association', (s) => ({ associated: s.associated }))
