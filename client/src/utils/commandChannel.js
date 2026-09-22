import { sendWebrtcEvent, sendWebrtcSessionEvent } from '../webrtc/client.js'
import { useFpeStore } from '../store/fpe.js'

const isPopup = !!new URLSearchParams(window.location.search).get('window')
const ch = new BroadcastChannel('tracs-commands')

// Main window: relay commands posted by popups into the live WebRTC connection,
// or (OPEN_FPE) run a one-shot action locally — never a piece of state to
// keep in sync, just "do this in main," same reasoning as the WebRTC relay.
if (!isPopup) {
  ch.onmessage = ({ data }) => {
    if (data?.type === 'WEBRTC_EVENT')             sendWebrtcEvent(data.event, data.payload)
    else if (data?.type === 'WEBRTC_SESSION_EVENT') sendWebrtcSessionEvent(data.event, data.payload)
    else if (data?.type === 'OPEN_FPE')             useFpeStore.getState().openFpe(data.payload)
  }
}

export function dispatchWebrtcEvent(type, payload) {
  if (!isPopup) sendWebrtcEvent(type, payload)
  else          ch.postMessage({ type: 'WEBRTC_EVENT', event: type, payload })
}

export function dispatchWebrtcSessionEvent(type, payload) {
  if (!isPopup) sendWebrtcSessionEvent(type, payload)
  else          ch.postMessage({ type: 'WEBRTC_SESSION_EVENT', event: type, payload })
}

// FPE is only ever rendered in the main window's scope components
// (StarsScope.jsx/AsdexScope.jsx) — a popup (e.g. the popped-out Strip Bay)
// has nothing mounted to show it, so this always opens it in main,
// regardless of which window calls it from.
export function dispatchOpenFpe(payload) {
  if (!isPopup) useFpeStore.getState().openFpe(payload)
  else          ch.postMessage({ type: 'OPEN_FPE', payload })
}
