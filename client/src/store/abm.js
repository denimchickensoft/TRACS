import { DECLARATION, createDeclarationStore } from '../utils/createDeclarationStore.js'

export { DECLARATION }

// ABM's declarations/BRAA state was ported from AIC's store/aic.js as-is —
// own room, NOT shared with AIC's declarations (deferred, see abm-spec.md
// §1.2). ROE, however, IS shared between AIC and ABM — it lives in its own
// cross-module store/roe.js, not here.
const {
  useStore: useAbmStore,
  register: registerAbmBroadcast,
  applyDeclaration: applyAbmDeclaration,
  applyAutoDeclareMode: applyAbmAutoDeclareMode,
  applyStateDump: applyAbmStateDump,
  applyDeclarationsReset: applyAbmDeclarationsReset,
} = createDeclarationStore({ storageKey: 'tracs.abm.autoDeclareMode', legacyStorageKey: 'tracs.abm.autoClassify' })

export {
  useAbmStore,
  registerAbmBroadcast,
  applyAbmDeclaration,
  applyAbmAutoDeclareMode,
  applyAbmStateDump,
  applyAbmDeclarationsReset,
}

// ABM-only override of the shared getEffectiveDeclaration fallback — same
// rationale as store/aic.js's getAicEffectiveDeclaration, kept as a fully
// separate function (not shared with AIC's) since the two stores never read
// each other's state (see header comment). An srsCapable, same-coalition
// contact with no explicit declaration defaults to BOGEY instead of the
// shared store's usual auto-FRIENDLY default, until manually declared or
// auto-declared via .autodec/.autodec iff. Deliberately NOT edited into
// createDeclarationStore.js's shared getEffectiveDeclaration itself.
// See resources/specs/transponder-correlation-spec.md.
export function getAbmEffectiveDeclaration(unitId, unit, myCoalitionNum) {
  const explicit = useAbmStore.getState().declarations[String(unitId)]
  if (explicit !== undefined) return explicit
  if (unit?.srsCapable) return DECLARATION.BOGEY
  return unit?.coalition === myCoalitionNum ? DECLARATION.FRIENDLY : DECLARATION.BOGEY
}
