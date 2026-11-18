// Cross-window Zustand store sync via BroadcastChannel.
//
// Scoped to one position: a channel joins only the windows of the same
// facility + position (the main window and its own pop-outs), named
// `<channel>-<facilityId>-<positionName>`. Every TRACS tab and window in a
// browser (or the desktop app, whose New Window signs into further
// positions) shares one origin, so an unscoped channel would let one
// position's state overwrite another's - and a window still at sign-in,
// fed another position's units and plans, would work out associations with
// none of that position's settings and broadcast them back. A pop-out knows
// its position from its URL (App.jsx adds facilityId/positionName to every
// one); a main window joins once sign-in sets them (setChannelIdentity, from
// store/session.js) and re-joins if they change. Until then it syncs nothing.
//
// On joining, a window broadcasts REQUEST_STATE so any window already there
// responds with its current state. On state change, it broadcasts
// STATE_UPDATE - but only when the picked slice itself changed. A store can
// carry more than one channel (store/atc.js syncs ownership and
// callsignOverrides separately), and each channel's isSyncing guard only
// covers its own apply: without the slice check, applying one channel's
// update re-posts the other's unchanged slice, the receiving window does the
// same in reverse, and the two channels ping-pong between windows forever,
// multiplying with every extra pop-out.
//
// `onlyWithPeers`: don't broadcast changes until another window has been heard
// from on this channel (a pop-out's REQUEST_STATE, or the replies to our
// own). For high-rate stores like units, whose full-map posts are wasted
// work when nothing else is open. Once a peer is seen it stays on.
//
// `global`: one channel for every window, for state that is the same for
// every position anyway (a browser-wide preference).

const _params  = typeof window !== 'undefined' ? new URLSearchParams(window.location?.search ?? '') : null
const IS_POPUP = !!_params?.get('window')

const identityOf = (facilityId, positionName) =>
  facilityId && positionName ? `${facilityId}-${positionName}` : null

let _identity = IS_POPUP ? identityOf(_params.get('facilityId'), _params.get('positionName')) : null
const _joiners = new Set()

// The main window's position, once sign-in sets it (store/session.js).
// Pop-outs keep the one from their URL.
export function setChannelIdentity(facilityId, positionName) {
  if (IS_POPUP) return
  const next = identityOf(facilityId, positionName)
  if (next === _identity) return
  _identity = next
  for (const join of _joiners) join()
}

/**
 * A BroadcastChannel shared only with this position's own windows.
 * `onOpen(channel)` runs each time it (re)joins, e.g. to ask for state.
 * @returns {{ post: (msg) => void }} post is a no-op while not joined.
 */
export function positionChannel(name, { onMessage, onOpen } = {}) {
  let ch = null
  const channel = { post: (msg) => ch?.postMessage(msg) }
  const join = () => {
    ch?.close()
    ch = null
    if (!_identity) return
    ch = new BroadcastChannel(`${name}-${_identity}`)
    if (onMessage) ch.onmessage = onMessage
    onOpen?.(channel)
  }
  _joiners.add(join)
  join()
  return channel
}

export function syncStore(store, channelName, pickState, { onlyWithPeers = false, global = false } = {}) {
  let isSyncing = false
  let peerSeen = !onlyWithPeers

  const onMessage = (e) => {
    peerSeen = true
    if (e.data?.type === 'STATE_UPDATE') {
      isSyncing = true
      store.setState(e.data.state)
      isSyncing = false
    } else if (e.data?.type === 'REQUEST_STATE') {
      ch.post({ type: 'STATE_UPDATE', state: pickState(store.getState()) })
    }
  }
  // Ask any windows already on the channel for their current state.
  const onOpen = (channel) => channel.post({ type: 'REQUEST_STATE' })

  let ch
  if (global) {
    const bc = new BroadcastChannel(channelName)
    bc.onmessage = onMessage
    ch = { post: (msg) => bc.postMessage(msg) }
    onOpen(ch)
  } else {
    ch = positionChannel(channelName, { onMessage, onOpen })
  }

  store.subscribe((state, prev) => {
    if (isSyncing || !peerSeen) return
    const slice = pickState(state)
    if (shallowEqual(slice, pickState(prev))) return
    ch.post({ type: 'STATE_UPDATE', state: slice })
  })
}

// True when both picked slices hold the same keys with reference-equal values.
// Store updates are immutable, so an unchanged field keeps its reference.
// Hand-rolled channels use this to skip posting on unrelated store changes.
export function shallowEqual(a, b) {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((k) => Object.hasOwn(b, k) && Object.is(a[k], b[k]))
}
