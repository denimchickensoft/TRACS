import { create } from 'zustand'

export const useFpeStore = create((set, get) => ({
  open:     false,
  scope:    null,    // which ODS instance should render the FPE ('atc', 'cab', etc.)
  aid:      null,    // pre-filled AID (may be null for blank open)
  unitId:   null,    // Olympus unit ID that was Ctrl+clicked (may be null)
  readOnly: false,   // true if track is owned by another controller

  // Scope used when a caller doesn't name one (e.g. the Strip Bay, which
  // isn't tied to a scope) — App.jsx keeps it on whichever ODS is showing
  // in the main window, so the FPE opens where the controller is looking.
  defaultScope: 'atc',
  setDefaultScope: (scope) => set({ defaultScope: scope }),

  openFpe: ({ aid = null, unitId = null, readOnly = false, scope = null } = {}) =>
    set({ open: true, scope: scope ?? get().defaultScope, aid, unitId, readOnly }),

  closeFpe: () =>
    set({ open: false, scope: null, aid: null, unitId: null, readOnly: false }),
}))
