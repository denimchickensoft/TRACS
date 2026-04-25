// Cross-window Zustand store sync via BroadcastChannel.
// On load, broadcasts REQUEST_STATE so any existing window responds with current state.
// On state change, broadcasts STATE_UPDATE to all other windows.
export function syncStore(store, channelName, pickState) {
  const ch = new BroadcastChannel(channelName)
  let isSyncing = false

  store.subscribe((state) => {
    if (!isSyncing) {
      ch.postMessage({ type: 'STATE_UPDATE', state: pickState(state) })
    }
  })

  ch.onmessage = (e) => {
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
