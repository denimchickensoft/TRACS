// Cross-window Zustand store sync via BroadcastChannel.
// On load, broadcasts REQUEST_STATE so any existing window responds with current state.
// On state change, broadcasts STATE_UPDATE to all other windows — but only when
// the picked slice itself changed. A store can carry more than one channel
// (store/atc.js syncs ownership and callsignOverrides separately), and each
// channel's isSyncing guard only covers its own apply: without the slice check,
// applying one channel's update re-posts the other's unchanged slice, the
// receiving window does the same in reverse, and the two channels ping-pong
// between windows forever, multiplying with every extra pop-out.
//
// `onlyWithPeers`: don't broadcast changes until another window has been heard
// from on this channel (a pop-out's load-time REQUEST_STATE, or the replies to
// our own). For high-rate stores like units, whose full-map posts are wasted
// work when nothing else is open. Once a peer is seen it stays on.
export function syncStore(store, channelName, pickState, { onlyWithPeers = false } = {}) {
  const ch = new BroadcastChannel(channelName)
  let isSyncing = false
  let peerSeen = !onlyWithPeers

  store.subscribe((state, prev) => {
    if (isSyncing || !peerSeen) return
    const slice = pickState(state)
    if (shallowEqual(slice, pickState(prev))) return
    ch.postMessage({ type: 'STATE_UPDATE', state: slice })
  })

  ch.onmessage = (e) => {
    peerSeen = true
    if (e.data?.type === 'STATE_UPDATE') {
      isSyncing = true
      store.setState(e.data.state)
      isSyncing = false
    } else if (e.data?.type === 'REQUEST_STATE') {
      ch.postMessage({ type: 'STATE_UPDATE', state: pickState(store.getState()) })
    }
  }

  // Ask any already-open windows for their current state
  ch.postMessage({ type: 'REQUEST_STATE' })
}

// True when both picked slices hold the same keys with reference-equal values.
// Store updates are immutable, so an unchanged field keeps its reference.
// Hand-rolled channels use this to skip posting on unrelated store changes.
export function shallowEqual(a, b) {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((k) => Object.hasOwn(b, k) && Object.is(a[k], b[k]))
}
