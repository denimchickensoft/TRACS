import { create } from 'zustand'

// AIC's 3 persisted local-UI toggles — a genuine reactive store, not a
// load/save-function pair like abmPrefs.js/asdexPrefs.js/catccPrefs.js/
// starsPrefs.js. Those four back a plain component useState with a manual
// dual-write (setState + saveXPrefs) at every toggle site; that works for
// them because none of their scope's execCommand needs to be closure-free.
// AIC's does (see resources/specs/refactor-spec.md §9), so these three need
// a single reactive source of truth that any file can read/write via
// .getState() — same auto-persist-on-change shape utils/createDeclarationStore.js
// already uses for autoDeclareMode.
//
// Before 2026-08-21 these three each hand-rolled their own separate
// localStorage key/try-catch pair directly in AicScope.jsx.

const KEY = 'tracs-aic-prefs'

const DEFAULTS = {
  autoThreat:  false, // .autothreat — auto-lit threat rings on breach
  showPicture: false, // .picture — PICTURE readout panel visibility
  becVisible:  false, // .bec — bullseye-on-cursor readout
  roeVisible:  true,  // .roe (no args) — ROE readout badge visibility
}

function loadPersisted() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY))
    return saved ? { ...DEFAULTS, ...saved } : { ...DEFAULTS }
  } catch {
    return { ...DEFAULTS }
  }
}

export const useAicPrefsStore = create((set) => ({
  ...loadPersisted(),
  setAutoThreat:  (enabled) => set({ autoThreat: enabled }),
  setShowPicture: (enabled) => set({ showPicture: enabled }),
  setBecVisible:  (enabled) => set({ becVisible: enabled }),
  setRoeVisible:  (enabled) => set({ roeVisible: enabled }),
}))

useAicPrefsStore.subscribe((state, prevState) => {
  if (state.autoThreat === prevState.autoThreat
    && state.showPicture === prevState.showPicture
    && state.becVisible === prevState.becVisible
    && state.roeVisible === prevState.roeVisible) return
  try {
    localStorage.setItem(KEY, JSON.stringify({
      autoThreat: state.autoThreat, showPicture: state.showPicture, becVisible: state.becVisible,
      roeVisible: state.roeVisible,
    }))
  } catch {
    // ignore (e.g. private browsing quota)
  }
})
