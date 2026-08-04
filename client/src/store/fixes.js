import { create } from 'zustand'

// FIXES DCB toggle — visibility only; the actual point data (id/lat/lon)
// lives in store/navdata.js, shared with CATCC/ABM/AIC. Same minimal
// visible/toggleVisible/setVisible shape as store/geo.js, so it plugs into
// Dcb.jsx's MAP submenu and the ODS preset save/load paths the same way
// RELIEF/GEO do.
export const useFixesStore = create((set) => ({
  visible: false,

  toggleVisible: () => set((s) => ({ visible: !s.visible })),
  setVisible:    (v) => set({ visible: v }),
  reset: () => set({ visible: false }),
}))
