import { create } from 'zustand'
import { createBroadcastHook } from '../utils/broadcastRegistry.js'

export const DECLARATION = {
  HOSTILE:  'HOSTILE',
  BOGEY:    'BOGEY',
  NEUTRAL:  'NEUTRAL',
  FRIENDLY: 'FRIENDLY',
}

const { register: registerAbmBroadcast, broadcast: _broadcastFn } = createBroadcastHook()
export { registerAbmBroadcast }

// autoClassify is a local UI preference, not session data — persisted to
// localStorage (2026-07-09) so it survives a page refresh even when no other
// ABM peer is connected to STATE_DUMP it back to you.
const AUTOCLASS_STORAGE_KEY = 'tracs.abm.autoClassify'

function loadStoredAutoClassify() {
  try {
    return localStorage.getItem(AUTOCLASS_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function applyAbmDeclaration(unitId, classification) {
  useAbmStore.getState()._applyDeclaration(unitId, classification)
}

export function applyAbmAutoClassify(enabled) {
  useAbmStore.getState()._applyAutoClassify(enabled)
}

export function applyAbmStateDump(payload) {
  const patch = {}
  if (payload.declarations) patch.declarations = payload.declarations
  if (payload.autoClassify !== undefined) patch.autoClassify = payload.autoClassify
  useAbmStore.setState(patch)
}

export function applyAbmDeclarationsReset() {
  useAbmStore.setState({ declarations: {}, autoClassify: false })
}

export const useAbmStore = create((set, get) => ({
  declarations: {},    // { [unitId]: DECLARATION } — own room, NOT shared with AIC's declarations (deferred, see abm-spec.md §1.2)
  autoClassify: loadStoredAutoClassify(), // .autoclass (2026-07-08) — see setAutoClassify below

  // BRAA line / bogey dope — ported from AIC's store/aic.js as-is: local to
  // this controller, not synced via WebRTC (same as AIC's braaList).
  braaList:           [],    // [{ id, fighterId, bogeyId }]
  pendingBraaFighter: null,  // unitId awaiting second Ctrl+click

  setDeclaration: (unitId, classification) => {
    set(s => ({ declarations: { ...s.declarations, [unitId]: classification } }))
    _broadcastFn('DECLARATION_SET', { unitId, classification })
  },

  // .class (no args) — return every explicit declaration to its fog-of-war
  // default (2026-07-07), and turn off autoclassification (2026-07-08).
  // Broadcast as one bulk event rather than N individual DECLARATION_SET
  // messages.
  resetDeclarations: () => {
    set({ declarations: {}, autoClassify: false })
    _broadcastFn('DECLARATIONS_RESET', {})
  },

  // .autoclass (2026-07-08) — see aic.js's setAutoClassify for the full
  // rationale (ported as-is: toggle only, bulk apply lives in AbmScope).
  setAutoClassify: (enabled) => {
    set({ autoClassify: enabled })
    _broadcastFn('AUTOCLASS_SET', { enabled })
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

  _applyAutoClassify: (enabled) => set({ autoClassify: enabled }),

  getEffectiveDeclaration: (unitId, unit, myCoalitionNum) => {
    const explicit = get().declarations[String(unitId)]
    if (explicit !== undefined) return explicit
    return unit.coalition === myCoalitionNum ? DECLARATION.FRIENDLY : DECLARATION.BOGEY
  },

  reset: () => set({ declarations: {}, autoClassify: false, braaList: [], pendingBraaFighter: null }),
}))

useAbmStore.subscribe((state, prevState) => {
  if (state.autoClassify === prevState.autoClassify) return
  try {
    localStorage.setItem(AUTOCLASS_STORAGE_KEY, String(state.autoClassify))
  } catch {
    // ignore (e.g. private browsing quota)
  }
})
