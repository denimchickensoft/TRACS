import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'
import { StripBayWindow }      from './components/StripBay/StripBayWindow'
import { StatusBoardWindow }   from './modules/catcc/StatusBoardWindow'
import { DeckWindow }          from './modules/catcc/DeckWindow'
import { ControllerListWindow } from './components/ControllerList/ControllerListWindow'
import { ParWindow }            from './components/par/ParWindow'
import { AsdexOdsWindow }      from './modules/atc/asdex/AsdexOdsWindow'
import { AtoWindow }           from './modules/abm/AtoWindow'
import { FragWindow }          from './modules/abm/FragWindow'
import { BraaListWindow }      from './modules/aic/BraaListWindow'

const _params    = new URLSearchParams(window.location.search)
const windowMode = _params.get('window')

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {windowMode === 'strips'      ? <StripBayWindow />       :
     windowMode === 'catcc-board' ? <StatusBoardWindow />    :
     windowMode === 'catcc-deck'  ? <DeckWindow />           :
     windowMode === 'cl'          ? <ControllerListWindow /> :
     windowMode === 'par'         ? <ParWindow />            :
     windowMode === 'asdex-ods'   ? <AsdexOdsWindow />       :
     windowMode === 'abm-ato'     ? <AtoWindow />            :
     windowMode === 'abm-frag'    ? <FragWindow />           :
     windowMode === 'braa'        ? <BraaListWindow />       :
     <App />}
  </StrictMode>
)
