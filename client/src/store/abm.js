import { DECLARATION, createDeclarationStore } from '../utils/createDeclarationStore.js'

export { DECLARATION }

// ABM's declarations/BRAA state was ported from AIC's store/aic.js as-is —
// own room, NOT shared with AIC's declarations (deferred, see abm-spec.md
// §1.2) — and genuinely has no ROE concept, unlike AIC (see abm-spec.md).
const {
  useStore: useAbmStore,
  register: registerAbmBroadcast,
  applyDeclaration: applyAbmDeclaration,
  applyAutoClassify: applyAbmAutoClassify,
  applyStateDump: applyAbmStateDump,
  applyDeclarationsReset: applyAbmDeclarationsReset,
} = createDeclarationStore({ storageKey: 'tracs.abm.autoClassify', withRoe: false })

export {
  useAbmStore,
  registerAbmBroadcast,
  applyAbmDeclaration,
  applyAbmAutoClassify,
  applyAbmStateDump,
  applyAbmDeclarationsReset,
}
