import { create } from 'zustand'
import { createBroadcastHook } from './broadcastRegistry.js'
import { syncStore } from './storeSync.js'

// Shared declaration/BRAA store shape for ABM and AIC — abm.js's own comment
// says its declarations/braaList were "ported from AIC's store/aic.js as-is."
//
// The two stores are separate zustand instances, but their `declarations`
// are kept identical (see the shared declarations section below). braaList and
// autoDeclareMode stay per module.
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

// Declarations are one shared picture across AIC and ABM, like ROE: a
// declaration made in either module is written to every declaration store and
// broadcast on the session room, so every controller sees it whatever module
// they're in. autoDeclareMode stays per module, because .autodec iff means
// different things in each (see above), and it keeps using the module room.
const declarationStores = []
const { register: registerDeclarationBroadcast, broadcast: broadcastDeclaration } = createBroadcastHook()
export { registerDeclarationBroadcast }

function writeToAllStores(patchFn) {
  for (const store of declarationStores) store.setState(patchFn)
}

// Remote DECLARATION_SET / DECLARATIONS_RESET / dump application - no re-broadcast.
export function applySharedDeclaration(unitId, declaration) {
  writeToAllStores(s => ({ declarations: { ...s.declarations, [unitId]: declaration } }))
}

// A reset clears every declaration everywhere, but turns off auto-declare only
// in the module it was typed in (the sender's own store does that locally).
export function applySharedDeclarationsReset() {
  writeToAllStores({ declarations: {} })
}

// Additive: a dump can be a stale snapshot, so it never removes a declaration
// this controller already has.
export function applySharedDeclarationsDump(declarations) {
  writeToAllStores(s => ({ declarations: { ...s.declarations, ...declarations } }))
}

export function getSharedDeclarations() {
  return declarationStores[0]?.getState().declarations ?? {}
}

export function createDeclarationStore({ storageKey, channelName }) {
  const { register, broadcast } = createBroadcastHook()

  function loadStoredAutoDeclareMode() {
    try {
      const stored = localStorage.getItem(storageKey)
      if (stored === AUTO_DECLARE_MODE.OFF || stored === AUTO_DECLARE_MODE.COALITION || stored === AUTO_DECLARE_MODE.IFF) {
        return stored
      }
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
      applySharedDeclaration(unitId, declaration)
      broadcastDeclaration('DECLARATION_SET', { unitId, declaration })
    },

    // .dec (no args) — return every explicit declaration to its fog-of-war
    // default, and turn off auto-declare. Broadcast as one bulk event rather
    // than N individual DECLARATION_SET messages.
    resetDeclarations: () => {
      applySharedDeclarationsReset()
      set({ autoDeclareMode: AUTO_DECLARE_MODE.OFF })
      broadcastDeclaration('DECLARATIONS_RESET', {})
      broadcast('AUTO_DECLARE_MODE_SET', { mode: AUTO_DECLARE_MODE.OFF })
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

  // Cross-window sync for this controller's own popup windows (e.g. AIC's
  // BraaList popup, ABM's focus-panel popup) — separate from the
  // cross-controller broadcast in the setters above, which sends declaration
  // and auto-declare changes to other controllers (braaList stays local to
  // this controller). Applying synced state here never re-broadcasts, since
  // it doesn't go through those setters. pendingBraaFighter is
  // excluded: it's transient in-progress-click state specific to whichever
  // window's cursor is mid-BRAA-pair, not something that should leak across
  // windows.
  if (typeof window !== 'undefined') {
    syncStore(useStore, channelName, (s) => ({
      declarations:    s.declarations,
      braaList:        s.braaList,
      autoDeclareMode: s.autoDeclareMode,
    }))
  }

  declarationStores.push(useStore)

  function applyAutoDeclareMode(mode) {
    useStore.getState()._applyAutoDeclareMode(mode)
  }

  // The module part of a STATE_DUMP. Declarations themselves arrive in every
  // module's dump and are applied through applySharedDeclarationsDump().
  function applyStateDump(payload) {
    if (payload.autoDeclareMode !== undefined) useStore.setState({ autoDeclareMode: payload.autoDeclareMode })
  }

  // Module-room DECLARATION_SET / DECLARATIONS_RESET, as sent by clients from
  // before declarations moved to the session room. Their reset also turned
  // auto-declare off in the sender's module.
  function applyModuleDeclaration(unitId, declaration) {
    applySharedDeclaration(unitId, declaration)
  }

  function applyModuleDeclarationsReset() {
    applySharedDeclarationsReset()
    useStore.setState({ autoDeclareMode: AUTO_DECLARE_MODE.OFF })
  }

  return {
    useStore, register,
    applyDeclaration: applyModuleDeclaration, applyAutoDeclareMode, applyStateDump,
    applyDeclarationsReset: applyModuleDeclarationsReset,
  }
}
