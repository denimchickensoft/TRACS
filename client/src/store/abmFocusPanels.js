// Registry of ABM focus panels currently floating in-page (see
// modules/abm/AbmFocusPanel.jsx / AbmScope.jsx's .focus command and
// double-click handler). Keyed by focus key — a callsign, a unit or a
// location (see utils/callsign.js). Session-only, not persisted — a
// popped-out focus panel isn't tracked here at all, it's just a separate
// window.open() popup (see actions/index.js's popOutAbmFocusPanel).

import { create } from 'zustand'

export const useAbmFocusPanelsStore = create((set) => ({
  order: [],           // focus key[] — last = frontmost
  rangeByKey: {},      // key -> initial rangeNm, only consulted on first open
  centerByKey: {},     // key -> initial {lat, lng} for a location, only consulted on first open

  openPanel: (key, rangeNm, center = null) => set((s) => ({
    order: s.order.includes(key) ? [...s.order.filter((k) => k !== key), key] : [...s.order, key],
    rangeByKey: { ...s.rangeByKey, [key]: rangeNm },
    centerByKey: { ...s.centerByKey, [key]: center },
  })),

  bringToFront: (key) => set((s) => (
    s.order.includes(key) ? { order: [...s.order.filter((k) => k !== key), key] } : {}
  )),

  closePanel: (key) => set((s) => ({ order: s.order.filter((k) => k !== key) })),
}))
