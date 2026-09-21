import { create } from 'zustand'
import { syncStore } from '../utils/storeSync.js'

// Shared "alert engine" state for ABM's missile-launch alert (sound +
// blink) — written only by the main ABM window's detection tick
// (modules/abm/missileAlert/useMissileAlertTracker.js, gated to
// windowId === DEFAULT_windowId), read by every open ABM window/focus-panel/
// pop-out for blink rendering and click-to-dismiss.
//
// Deliberately NOT per-window: a popped-out focus window (AbmFocusWindow.jsx,
// via window.open()) is a genuinely separate renderer with its own
// AudioContext. If every window independently ran detection+audio, opening a
// focus panel while an alert was active would sound a second, uncoordinated
// tone — "only one alert engine per module." Single shared store + single
// owner avoids that; every other window just reflects this state.
export const useAbmMissileAlertStore = create((set, get) => ({
  activeIds: {}, // { [weaponId]: true } — currently alerting (sounding + blinking) missiles

  // Full replace — called by the owner window's detection tick.
  setActiveIds: (ids) => set({ activeIds: ids }),

  // Click-to-cancel — callable from any window (main, focus panel, pop-out).
  dismiss: (id) => {
    if (!get().activeIds[id]) return
    const next = { ...get().activeIds }
    delete next[id]
    set({ activeIds: next })
  },

  clear: () => set({ activeIds: {} }),
}))

if (typeof window !== 'undefined') {
  syncStore(useAbmMissileAlertStore, 'tracs-abm-missile-alert', (s) => ({ activeIds: s.activeIds }))
}
