// Cross-window Zustand store sync via BroadcastChannel.
// On load, broadcasts REQUEST_STATE so any existing window responds with current state.
// On state change, broadcasts STATE_UPDATE to all other windows.
//
// `onlyWithPeers`: don't broadcast changes until another window has been heard
// from on this channel (a pop-out's load-time REQUEST_STATE, or the replies to
// our own). For high-rate stores like units, whose full-map posts are wasted
// work when nothing else is open. Once a peer is seen it stays on.
export function syncStore(store, channelName, pickState, { onlyWithPeers = false } = {}) {
  const ch = new BroadcastChannel(channelName)
  let isSyncing = false
  let peerSeen = !onlyWithPeers

  store.subscribe((state) => {
    if (!isSyncing && peerSeen) {
      ch.postMessage({ type: 'STATE_UPDATE', state: pickState(state) })
    }
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
