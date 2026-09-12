import { DECLARATION, createDeclarationStore } from '../utils/createDeclarationStore.js'

export { DECLARATION }

const {
  useStore: useAicStore,
  register: registerAicBroadcast,
  applyDeclaration: applyAicDeclaration,
  applyAutoClassify: applyAicAutoClassify,
  applyStateDump: applyAicStateDump,
  applyDeclarationsReset: applyAicDeclarationsReset,
} = createDeclarationStore({ storageKey: 'tracs.aic.autoClassify' })

export {
  useAicStore,
  registerAicBroadcast,
  applyAicDeclaration,
  applyAicAutoClassify,
  applyAicStateDump,
  applyAicDeclarationsReset,
}
