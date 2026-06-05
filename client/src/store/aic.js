import { create } from 'zustand'

export const DECLARATION = {
  HOSTILE:  'HOSTILE',
  UNKNOWN:  'UNKNOWN',
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

export function applyAicDeclaration(unitId, classification) {
  useAicStore.getState()._applyDeclaration(unitId, classification)
}

export function applyAicRoe(roe) {
  useAicStore.getState()._applyRoe(roe)
}

export function applyAicStateDump(payload) {
  const patch = {}
  if (payload.declarations) patch.declarations = payload.declarations
  if (payload.roe !== undefined) patch.roe = payload.roe
  useAicStore.setState(patch)
}

export const useAicStore = create((set, get) => ({
  declarations:       {},    // { [unitId]: DECLARATION }
  roe:                null,  // ROE_STATE | null
  braaList:           [],    // [{ id, fighterId, bogeyId }] — local, not synced
  pendingBraaFighter: null,  // unitId awaiting second Ctrl+click

  setDeclaration: (unitId, classification) => {
    set(s => ({ declarations: { ...s.declarations, [unitId]: classification } }))
    _broadcastFn?.('DECLARATION_SET', { unitId, classification })
  },

  setRoe: (roe) => {
    set({ roe })
    _broadcastFn?.('ROE_SET', { roe })
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

  getEffectiveDeclaration: (unitId, unit, myCoalitionNum) => {
    const explicit = get().declarations[String(unitId)]
    if (explicit !== undefined) return explicit
    const c = unit.coalition
    if (c === myCoalitionNum) return DECLARATION.FRIENDLY
    if (c === 0) return DECLARATION.NEUTRAL
    return DECLARATION.HOSTILE
  },

  reset: () => set({ declarations: {}, roe: null, braaList: [], pendingBraaFighter: null }),
}))
