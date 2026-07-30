import { create } from 'zustand'

export const DECLARATION = {
  HOSTILE:  'HOSTILE',
  BOGEY:    'BOGEY',
  NEUTRAL:  'NEUTRAL',
  FRIENDLY: 'FRIENDLY',
}

export const ROE_STATE = {
  FREE:  'FREE',
  TIGHT: 'TIGHT',
  HOLD:  'HOLD',
}

let _broadcastFn = null

export function registerAicBroadcast(fn) {
  _broadcastFn = fn
}

// autoClassify is a local UI preference, not session data — persisted to
// localStorage (2026-07-09) so it survives a page refresh even when no other
// AIC peer is connected to STATE_DUMP it back to you.
const AUTOCLASS_STORAGE_KEY = 'tracs.aic.autoClassify'

function loadStoredAutoClassify() {
  try {
    return localStorage.getItem(AUTOCLASS_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function applyAicDeclaration(unitId, classification) {
  useAicStore.getState()._applyDeclaration(unitId, classification)
}

export function applyAicRoe(roe) {
  useAicStore.getState()._applyRoe(roe)
}

export function applyAicAutoClassify(enabled) {
  useAicStore.getState()._applyAutoClassify(enabled)
}

export function applyAicStateDump(payload) {
  const patch = {}
  if (payload.declarations) patch.declarations = payload.declarations
  if (payload.roe !== undefined) patch.roe = payload.roe
  if (payload.autoClassify !== undefined) patch.autoClassify = payload.autoClassify
  useAicStore.setState(patch)
}

export function applyAicDeclarationsReset() {
  useAicStore.setState({ declarations: {}, autoClassify: false })
}

export const useAicStore = create((set, get) => ({
  declarations:       {},    // { [unitId]: DECLARATION }
  roe:                null,  // ROE_STATE | null
  autoClassify:       loadStoredAutoClassify(), // .autoclass (2026-07-08) — see setAutoClassify below
  braaList:           [],    // [{ id, fighterId, bogeyId }] — local, not synced
  pendingBraaFighter: null,  // unitId awaiting second Ctrl+click

  setDeclaration: (unitId, classification) => {
    set(s => ({ declarations: { ...s.declarations, [unitId]: classification } }))
    _broadcastFn?.('DECLARATION_SET', { unitId, classification })
  },

  // .class (no args) — return every explicit declaration to its fog-of-war
  // default (2026-07-07), and turn off autoclassification (2026-07-08).
  // Broadcast as one bulk event rather than N individual DECLARATION_SET
  // messages.
  resetDeclarations: () => {
    set({ declarations: {}, autoClassify: false })
    _broadcastFn?.('DECLARATIONS_RESET', {})
  },

  setRoe: (roe) => {
    set({ roe })
    _broadcastFn?.('ROE_SET', { roe })
  },

  // .autoclass (2026-07-08) — when on, every unit is classified to its TRUE
  // (coalition-based) declaration as it becomes visible; the bulk apply for
  // units already visible at toggle-on time happens in AicScope (it needs
  // live unit data the store doesn't hold). Toggling off does not revert
  // existing declarations, it just stops future auto-declaration.
  setAutoClassify: (enabled) => {
    set({ autoClassify: enabled })
    _broadcastFn?.('AUTOCLASS_SET', { enabled })
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

  _applyRoe: (roe) => set({ roe }),

  _applyAutoClassify: (enabled) => set({ autoClassify: enabled }),

  getEffectiveDeclaration: (unitId, unit, myCoalitionNum) => {
    const explicit = get().declarations[String(unitId)]
    if (explicit !== undefined) return explicit
    return unit.coalition === myCoalitionNum ? DECLARATION.FRIENDLY : DECLARATION.BOGEY
  },

  reset: () => set({ declarations: {}, roe: null, autoClassify: false, braaList: [], pendingBraaFighter: null }),
}))

useAicStore.subscribe((state, prevState) => {
  if (state.autoClassify === prevState.autoClassify) return
  try {
    localStorage.setItem(AUTOCLASS_STORAGE_KEY, String(state.autoClassify))
  } catch {
    // ignore (e.g. private browsing quota)
  }
})
