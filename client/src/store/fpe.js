import { create } from 'zustand'

export const useFpeStore = create((set) => ({
  open:     false,
  scope:    null,    // which ODS instance should render the FPE ('atc', 'cab', etc.)
  aid:      null,    // pre-filled AID (may be null for blank open)
  unitId:   null,    // Olympus unit ID that was Ctrl+clicked (may be null)
  readOnly: false,   // true if track is owned by another controller

  openFpe: ({ aid = null, unitId = null, readOnly = false, scope = null } = {}) =>
    set({ open: true, scope, aid, unitId, readOnly }),

  closeFpe: () =>
    set({ open: false, scope: null, aid: null, unitId: null, readOnly: false }),
}))

