import { DECLARATION, createDeclarationStore } from '../utils/createDeclarationStore.js'

export { DECLARATION }

const {
  useStore: useAicStore,
  register: registerAicBroadcast,
  applyDeclaration: applyAicDeclaration,
  applyAutoDeclareMode: applyAicAutoDeclareMode,
  applyStateDump: applyAicStateDump,
  applyDeclarationsReset: applyAicDeclarationsReset,
} = createDeclarationStore({ storageKey: 'tracs.aic.autoDeclareMode', channelName: 'tracs-aic-declarations' })

export {
  useAicStore,
  registerAicBroadcast,
  applyAicDeclaration,
  applyAicAutoDeclareMode,
  applyAicStateDump,
  applyAicDeclarationsReset,
}

// AIC-only override of the shared getEffectiveDeclaration fallback — an
// srsCapable, same-coalition contact with no explicit declaration defaults
// to BOGEY instead of the shared store's usual auto-FRIENDLY default (the
// same fog-of-war resting state every other contact already gets), until
// manually declared or auto-declared via .autodec/.autodec iff. Deliberately
// NOT edited into createDeclarationStore.js's shared getEffectiveDeclaration
// itself — ABM reads that same function for its own (unrelated) declaration-
// color computation, and this default change is AIC-specific.
export function getAicEffectiveDeclaration(unitId, unit, myCoalitionNum) {
  const explicit = useAicStore.getState().declarations[String(unitId)]
  if (explicit !== undefined) return explicit
  if (unit?.srsCapable) return DECLARATION.BOGEY
  return unit?.coalition === myCoalitionNum ? DECLARATION.FRIENDLY : DECLARATION.BOGEY
}
