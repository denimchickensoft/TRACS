// Registry of ABM focus panels currently floating in-page (see
// modules/abm/AbmFocusPanel.jsx / AbmScope.jsx's .focus command and
// double-click-a-contact handler). Session-only, not persisted — a
// popped-out focus panel isn't tracked here at all, it's just a separate
// window.open() popup (see actions/index.js's popOutAbmFocusPanel).

import { create } from 'zustand'

export const useAbmFocusPanelsStore = create((set) => ({
  order: [],              // callsign[] — last = frontmost
  rangeByCallsign: {},     // callsign -> initial rangeNm, only consulted on first open

  openPanel: (callsign, rangeNm) => set((s) => ({
    order: s.order.includes(callsign) ? [...s.order.filter((c) => c !== callsign), callsign] : [...s.order, callsign],
    rangeByCallsign: { ...s.rangeByCallsign, [callsign]: rangeNm },
  })),

  bringToFront: (callsign) => set((s) => (
    s.order.includes(callsign) ? { order: [...s.order.filter((c) => c !== callsign), callsign] } : {}
  )),

  closePanel: (callsign) => set((s) => ({ order: s.order.filter((c) => c !== callsign) })),
}))
