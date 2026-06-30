import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'
import { StripBayWindow }      from './components/StripBay/StripBayWindow'
import { StatusBoardWindow }   from './modules/catcc/StatusBoardWindow'
import { ControllerListWindow } from './components/ControllerList/ControllerListWindow'
import { ParWindow }            from './components/par/ParWindow'
import { AsdexOdsWindow }      from './modules/atc/asdex/AsdexOdsWindow'

const _params    = new URLSearchParams(window.location.search)
const windowMode = _params.get('window')

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {windowMode === 'strips'      ? <StripBayWindow />       :
     windowMode === 'catcc-board' ? <StatusBoardWindow />    :
     windowMode === 'cl'          ? <ControllerListWindow /> :
     windowMode === 'par'         ? <ParWindow />            :
     windowMode === 'asdex-ods'   ? <AsdexOdsWindow />       :
     <App />}
  </StrictMode>
)
