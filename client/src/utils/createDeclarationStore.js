import { create } from 'zustand'
import { createBroadcastHook } from './broadcastRegistry.js'

// Shared declaration/BRAA store shape for ABM and AIC — abm.js's own comment
// says its declarations/braaList were "ported from AIC's store/aic.js as-is."
//
// Each caller (abm.js/aic.js) still owns its own declarations/braaList DATA —
// this only shares the store SHAPE and action logic; the two stores remain
// two independent zustand instances, never reading each other's state.
// (ROE used to be gated here via `withRoe`, but it's genuinely shared
// cross-module state now — see store/roe.js.)
export const DECLARATION = {
  HOSTILE:  'HOSTILE',
  BOGEY:    'BOGEY',
  NEUTRAL:  'NEUTRAL',
  FRIENDLY: 'FRIENDLY',
}

// autoDeclareMode: 'off' | 'coalition' | 'iff'. 'coalition' is the old
// autoClassify=true behavior (declare everything to ground truth,
// unconditionally). 'iff' is a stricter, FRIENDLY-only mode — see each
// caller's own actions/index.js for what 'iff' actually gates on
// (module-specific: AIC uses SRS Mode 4, ABM uses FRAG-assigned code
// correlation) — this store only holds the bare mode string and its
// mutual-exclusivity/sync mechanics, not the matching logic itself.
export const AUTO_DECLARE_MODE = { OFF: 'off', COALITION: 'coalition', IFF: 'iff' }

export function createDeclarationStore({ storageKey, legacyStorageKey }) {
  const { register, broadcast } = createBroadcastHook()

  function loadStoredAutoDeclareMode() {
    try {
      const stored = localStorage.getItem(storageKey)
      if (stored === AUTO_DECLARE_MODE.OFF || stored === AUTO_DECLARE_MODE.COALITION || stored === AUTO_DECLARE_MODE.IFF) {
        return stored
      }
      // One-time migration from the old boolean autoClassify key — 'true'
      // meant unconditional ground-truth auto-declare, i.e. today's
      // 'coalition' mode.
      if (legacyStorageKey && localStorage.getItem(legacyStorageKey) === 'true') return AUTO_DECLARE_MODE.COALITION
      return AUTO_DECLARE_MODE.OFF
    } catch {
      return AUTO_DECLARE_MODE.OFF
    }
  }

  const useStore = create((set, get) => ({
    declarations: {},    // { [unitId]: DECLARATION }
    autoDeclareMode: loadStoredAutoDeclareMode(),

    // BRAA line / bogey dope — local to this controller, not synced via WebRTC.
    braaList:           [],    // [{ id, fighterId, bogeyId }]
    pendingBraaFighter: null,  // unitId awaiting second Ctrl+click

    setDeclaration: (unitId, declaration) => {
      set(s => ({ declarations: { ...s.declarations, [unitId]: declaration } }))
      broadcast('DECLARATION_SET', { unitId, declaration })
    },

    // .dec (no args) — return every explicit declaration to its fog-of-war
    // default, and turn off auto-declare. Broadcast as one bulk event rather
    // than N individual DECLARATION_SET messages.
    resetDeclarations: () => {
      set({ declarations: {}, autoDeclareMode: AUTO_DECLARE_MODE.OFF })
      broadcast('DECLARATIONS_RESET', {})
    },

    // .autodec / .autodec iff — mutually exclusive three-state toggle.
    // Turning a mode ON applies it immediately to every currently-visible
    // contact (the bulk apply happens in the scope component, which needs
    // live unit data this store doesn't hold); switching modes or turning
    // off never reverts anything already declared, it just stops future
    // auto-declaration under the old mode.
    setAutoDeclareMode: (mode) => {
      set({ autoDeclareMode: mode })
      broadcast('AUTO_DECLARE_MODE_SET', { mode })
    },

    addBraaPair: (fighterId, bogeyId) => {
      set(s => {
        if (s.braaList.some(p => p.fighterId === fighterId && p.bogeyId === bogeyId)) return { pendingBraaFighter: null }
        const id = `${fighterId}-${bogeyId}-${Date.now()}`
        return { braaList: [...s.braaList, { id, fighterId, bogeyId }], pendingBraaFighter: null }
      })
    },

    removeBraaPair: (id) => {
      set(s => ({ braaList: s.braaList.filter(p => p.id !== id) }))
    },

    removeBraaPairsForUnit: (unitId) => {
      set(s => ({
        braaList:           s.braaList.filter(p => p.fighterId !== unitId && p.bogeyId !== unitId),
        pendingBraaFighter: s.pendingBraaFighter === unitId ? null : s.pendingBraaFighter,
      }))
    },

    setPendingBraaFighter: (unitId) => set({ pendingBraaFighter: unitId }),
    clearPendingBraa:      ()       => set({ pendingBraaFighter: null }),

    _applyDeclaration: (unitId, declaration) => {
      set(s => ({ declarations: { ...s.declarations, [unitId]: declaration } }))
    },

    _applyAutoDeclareMode: (mode) => set({ autoDeclareMode: mode }),

    getEffectiveDeclaration: (unitId, unit, myCoalitionNum) => {
      const explicit = get().declarations[String(unitId)]
      if (explicit !== undefined) return explicit
      return unit.coalition === myCoalitionNum ? DECLARATION.FRIENDLY : DECLARATION.BOGEY
    },

    reset: () => set({
      declarations: {}, autoDeclareMode: AUTO_DECLARE_MODE.OFF, braaList: [], pendingBraaFighter: null,
    }),
  }))

  useStore.subscribe((state, prevState) => {
    if (state.autoDeclareMode === prevState.autoDeclareMode) return
    try {
      localStorage.setItem(storageKey, state.autoDeclareMode)
    } catch {
      // ignore (e.g. private browsing quota)
    }
  })

  function applyDeclaration(unitId, declaration) {
    useStore.getState()._applyDeclaration(unitId, declaration)
  }

  function applyAutoDeclareMode(mode) {
    useStore.getState()._applyAutoDeclareMode(mode)
  }

  function applyStateDump(payload) {
    const patch = {}
    if (payload.declarations) patch.declarations = payload.declarations
    if (payload.autoDeclareMode !== undefined) patch.autoDeclareMode = payload.autoDeclareMode
    useStore.setState(patch)
  }

  function applyDeclarationsReset() {
    useStore.setState({ declarations: {}, autoDeclareMode: AUTO_DECLARE_MODE.OFF })
  }

  return {
    useStore, register,
    applyDeclaration, applyAutoDeclareMode, applyStateDump, applyDeclarationsReset,
  }
}
