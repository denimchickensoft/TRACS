import { useDisplayStore } from '../../../store/display.js'
import { ASDEX_WINDOW_ID } from './AsdexDcb.jsx'

// Global DB ON/OFF (DCB button and F6). Any per-track click toggles are reset.
export function setAllDatablocks(on) {
  useDisplayStore.getState().updateWindow(ASDEX_WINDOW_ID, { dbOn: on, dbToggled: {} })
}

export function toggleAllDatablocks() {
  const win = useDisplayStore.getState().windows[ASDEX_WINDOW_ID]
  setAllDatablocks(!(win?.dbOn ?? true))
}
