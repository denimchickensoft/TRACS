import { sendWebrtcEvent, sendWebrtcSessionEvent } from '../webrtc/client.js'

const isPopup = !!new URLSearchParams(window.location.search).get('window')
const ch = new BroadcastChannel('tracs-commands')

// Main window: relay commands posted by popups into the live WebRTC connection.
if (!isPopup) {
  ch.onmessage = ({ data }) => {
    if (data?.type === 'WEBRTC_EVENT')             sendWebrtcEvent(data.event, data.payload)
    else if (data?.type === 'WEBRTC_SESSION_EVENT') sendWebrtcSessionEvent(data.event, data.payload)
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
