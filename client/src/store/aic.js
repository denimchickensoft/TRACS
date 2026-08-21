import { DECLARATION, createDeclarationStore } from '../utils/createDeclarationStore.js'

export { DECLARATION }

export const ROE_STATE = {
  FREE:  'FREE',
  TIGHT: 'TIGHT',
  HOLD:  'HOLD',
}

const {
  useStore: useAicStore,
  register: registerAicBroadcast,
  applyDeclaration: applyAicDeclaration,
  applyAutoClassify: applyAicAutoClassify,
  applyStateDump: applyAicStateDump,
  applyDeclarationsReset: applyAicDeclarationsReset,
  applyRoe: applyAicRoe,
} = createDeclarationStore({ storageKey: 'tracs.aic.autoClassify', withRoe: true })

export {
  useAicStore,
  registerAicBroadcast,
  applyAicDeclaration,
  applyAicAutoClassify,
  applyAicStateDump,
  applyAicDeclarationsReset,
  applyAicRoe,
}
