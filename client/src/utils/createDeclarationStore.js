import { create } from 'zustand'
import { createBroadcastHook } from './broadcastRegistry.js'

// Shared declaration/BRAA store shape for ABM and AIC — abm.js's own comment
// says its declarations/braaList were "ported from AIC's store/aic.js as-is."
// The two stores are otherwise identical except ROE, which AIC genuinely has
// and ABM genuinely doesn't (not a missing feature — see abm-spec.md §1.2) —
// gated here by `withRoe` rather than adding a no-op ROE surface to ABM.
//
// Each caller (abm.js/aic.js) still owns its own declarations/braaList DATA —
// this only shares the store SHAPE and action logic; the two stores remain
// two independent zustand instances, never reading each other's state.
export const DECLARATION = {
  HOSTILE:  'HOSTILE',
  BOGEY:    'BOGEY',
  NEUTRAL:  'NEUTRAL',
  FRIENDLY: 'FRIENDLY',
}

export function createDeclarationStore({ storageKey, withRoe = false }) {
  const { register, broadcast } = createBroadcastHook()

  function loadStoredAutoClassify() {
    try {
      return localStorage.getItem(storageKey) === 'true'
    } catch {
      return false
    }
  }

  const useStore = create((set, get) => ({
    declarations: {},    // { [unitId]: DECLARATION }
    autoClassify: loadStoredAutoClassify(),
    ...(withRoe ? { roe: null } : {}), // ROE_STATE | null

    // BRAA line / bogey dope — local to this controller, not synced via WebRTC.
    braaList:           [],    // [{ id, fighterId, bogeyId }]
    pendingBraaFighter: null,  // unitId awaiting second Ctrl+click

    setDeclaration: (unitId, classification) => {
      set(s => ({ declarations: { ...s.declarations, [unitId]: classification } }))
      broadcast('DECLARATION_SET', { unitId, classification })
    },

    // .class (no args) — return every explicit declaration to its fog-of-war
    // default, and turn off autoclassification. Broadcast as one bulk event
    // rather than N individual DECLARATION_SET messages.
    resetDeclarations: () => {
      set({ declarations: {}, autoClassify: false })
      broadcast('DECLARATIONS_RESET', {})
    },

    ...(withRoe ? {
      setRoe: (roe) => {
        set({ roe })
        broadcast('ROE_SET', { roe })
      },
    } : {}),

    // .autoclass — when on, every unit is classified to its TRUE (coalition-
    // based) declaration as it becomes visible; the bulk apply for units
    // already visible at toggle-on time happens in the scope component (it
    // needs live unit data the store doesn't hold). Toggling off does not
    // revert existing declarations, it just stops future auto-declaration.
    setAutoClassify: (enabled) => {
      set({ autoClassify: enabled })
      broadcast('AUTOCLASS_SET', { enabled })
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

    _applyDeclaration: (unitId, classification) => {
      set(s => ({ declarations: { ...s.declarations, [unitId]: classification } }))
    },

    ...(withRoe ? { _applyRoe: (roe) => set({ roe }) } : {}),

    _applyAutoClassify: (enabled) => set({ autoClassify: enabled }),

    getEffectiveDeclaration: (unitId, unit, myCoalitionNum) => {
      const explicit = get().declarations[String(unitId)]
      if (explicit !== undefined) return explicit
      return unit.coalition === myCoalitionNum ? DECLARATION.FRIENDLY : DECLARATION.BOGEY
    },

    reset: () => set({
      declarations: {}, autoClassify: false, braaList: [], pendingBraaFighter: null,
      ...(withRoe ? { roe: null } : {}),
    }),
  }))

  useStore.subscribe((state, prevState) => {
    if (state.autoClassify === prevState.autoClassify) return
    try {
      localStorage.setItem(storageKey, String(state.autoClassify))
    } catch {
      // ignore (e.g. private browsing quota)
    }
  })

  function applyDeclaration(unitId, classification) {
    useStore.getState()._applyDeclaration(unitId, classification)
  }

  function applyAutoClassify(enabled) {
    useStore.getState()._applyAutoClassify(enabled)
  }

  function applyStateDump(payload) {
    const patch = {}
    if (payload.declarations) patch.declarations = payload.declarations
    if (withRoe && payload.roe !== undefined) patch.roe = payload.roe
    if (payload.autoClassify !== undefined) patch.autoClassify = payload.autoClassify
    useStore.setState(patch)
  }

  function applyDeclarationsReset() {
    useStore.setState({ declarations: {}, autoClassify: false })
  }

  const applyRoe = withRoe
    ? (roe) => { useStore.getState()._applyRoe(roe) }
    : undefined

  return {
    useStore, register,
    applyDeclaration, applyAutoClassify, applyStateDump, applyDeclarationsReset, applyRoe,
  }
}
