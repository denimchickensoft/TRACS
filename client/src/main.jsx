import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'
import { StripBayWindow } from './components/StripBay/StripBayWindow'

const windowMode = new URLSearchParams(window.location.search).get('window')

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {windowMode === 'strips' ? <StripBayWindow /> : <App />}
  </StrictMode>
)
