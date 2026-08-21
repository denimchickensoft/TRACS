// Shared "outgoing WebRTC broadcast" registration pattern: a store module
// holds a nullable function, set once by webrtc/client.js after sign-in, and
// calls it (if present) whenever it needs to send an outgoing event. Kept
// generic over call signature since callers differ — aic.js/abm.js call
// broadcast(eventType, payload), statusBoard.js calls broadcast(payload).
export function createBroadcastHook() {
  let fn = null
  return {
    register: (f) => { fn = f },
    broadcast: (...args) => fn?.(...args),
  }
}
