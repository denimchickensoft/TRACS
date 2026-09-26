import { useFpeStore } from '../store/fpe.js'

const isPopup = !!new URLSearchParams(window.location.search).get('window')
const ch = new BroadcastChannel('tracs-commands')

// Main window: run one-shot actions posted by popups (never a piece of state
// to keep in sync, just "do this in main"). Outbound WebRTC events from
// popups don't come through here — webrtc/client.js's send functions forward
// those to the main window themselves.
if (!isPopup) {
  ch.onmessage = ({ data }) => {
    if (data?.type === 'OPEN_FPE') useFpeStore.getState().openFpe(data.payload)
  }
}

// FPE is only ever rendered in the main window's scope components
// (StarsScope.jsx/AsdexScope.jsx) — a popup (e.g. the popped-out Strip Bay)
// has nothing mounted to show it, so this always opens it in main,
// regardless of which window calls it from.
export function dispatchOpenFpe(payload) {
  if (!isPopup) useFpeStore.getState().openFpe(payload)
  else          ch.postMessage({ type: 'OPEN_FPE', payload })
}
