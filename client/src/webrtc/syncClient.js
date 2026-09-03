// Centralized-sync transport — an automatic substitute for the
// Trystero/WebRTC P2P mesh whenever a TRACS relay is reachable. See
// resources/specs/data-sources/webrtc-centralized-sync-spec.md §2/§3.
//
// Two exports:
//   - checkSyncCapable(): one-shot reachability+auth check, used by
//     Login.jsx's ConnectPhase before sign-in.
//   - { joinRoom, selfId }: duck-typed to match the Trystero strategy
//     modules (nostrStrategy/wsRelayStrategy) closely enough that
//     client.js can select this as a third `strategy` value.

const CHECK_TIMEOUT_MS     = 6_000
const RECONNECT_MS         = 3_000
const CAPABILITY_CHECK_ID  = 'capability-check'

function syncUrl(relayUrl) {
  return `${relayUrl.replace(/\/+$/, '')}/sync`
}

// ── One-shot capability + auth check ───────────────────────────────────────
// Opens its own throwaway connection (not the shared one below) — a
// separate, short-lived probe is the right shape here specifically because
// it runs before any room is known (Login's ConnectPhase, ahead of
// position/module selection). The real per-room connections opened later by
// joinRoom() authenticate near-instantly once this has already proven the
// password good, so there's no meaningful double-handshake cost.
export function checkSyncCapable({ relayUrl, password }) {
  return new Promise((resolve) => {
    let settled = false
    let ws
    try {
      ws = new WebSocket(syncUrl(relayUrl))
    } catch {
      resolve({ capable: false, reason: 'unreachable' })
      return
    }

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ws.close()
      resolve(result)
    }

    const timer = setTimeout(() => finish({ capable: false, reason: 'unreachable' }), CHECK_TIMEOUT_MS)

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', password, peerId: CAPABILITY_CHECK_ID }))
    }
    ws.onmessage = (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.type === 'auth_ok') finish({ capable: true })
    }
    ws.onclose = (ev) => {
      finish({ capable: false, reason: ev.reason === 'invalid password' ? 'password' : 'unreachable' })
    }
    ws.onerror = () => {} // onclose always follows; let it resolve
  })
}

// ── Shared connection, subscribed to N topics ──────────────────────────────
// One WebSocket per browser tab, reused across joinRoom() calls (session
// room + module room), matching the topic-based pub/sub design in
// webrtc-centralized-sync-spec.md §2.1 rather than opening one connection
// per room the way Trystero's two joinRoom() calls do.
export let selfId = null

let ws           = null
let ready        = false
let readyQueue   = []
let cfgInUse     = null
const topicState = new Map()   // topic → { onData: fn|null, onJoin: [fn], onLeave: [fn] }

function topic(t) {
  let s = topicState.get(t)
  if (!s) { s = { onData: null, onJoin: [], onLeave: [] }; topicState.set(t, s) }
  return s
}

function send(obj) {
  const payload = JSON.stringify(obj)
  if (ready) ws.send(payload)
  else readyQueue.push(payload)
}

function connect(cfg) {
  cfgInUse = cfg
  ws = new WebSocket(syncUrl(cfg.relayUrl))

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', password: cfg.password, peerId: selfId }))
  }

  ws.onmessage = (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }

    if (msg.type === 'auth_ok') {
      ready = true
      // Re-subscribe to every room already joined (first connect, or a
      // reconnect after a drop) and flush anything queued meanwhile.
      for (const t of topicState.keys()) ws.send(JSON.stringify({ type: 'subscribe', topic: t }))
      for (const payload of readyQueue) ws.send(payload)
      readyQueue = []
      return
    }
    if (msg.type === 'publish' && topicState.has(msg.topic)) {
      const envelope = msg.payload
      topicState.get(msg.topic).onData?.(envelope, envelope?.fromPeerId)
      return
    }
    if (msg.type === 'peer_join' && topicState.has(msg.topic)) {
      for (const cb of topicState.get(msg.topic).onJoin) cb(msg.peerId)
      return
    }
    if (msg.type === 'peer_leave' && topicState.has(msg.topic)) {
      for (const cb of topicState.get(msg.topic).onLeave) cb(msg.peerId)
    }
  }

  ws.onclose = (ev) => {
    ready = false
    if (!cfgInUse) return // intentional teardown (leave() cleared it) — no reconnect

    // A password rejection won't resolve itself by retrying (same reasoning
    // as server/src/srs.js's identical guard) -- this shouldn't normally
    // happen, since Login's ConnectPhase already validated the password
    // before initWebrtc() ever selects this transport, but a relay
    // reconfigured mid-session is a real enough edge case to not loop on.
    if (ev.reason === 'invalid password') {
      console.error('[sync] relay rejected our password — not retrying')
      cfgInUse = null
      ws = null
      return
    }

    console.warn(`[sync] disconnected from relay — reconnecting in ${RECONNECT_MS}ms`)
    setTimeout(() => { if (cfgInUse) connect(cfgInUse) }, RECONNECT_MS)
  }

  ws.onerror = () => {} // onclose always follows
}

export function joinRoom(cfg, roomId) {
  if (!selfId) selfId = crypto.randomUUID()
  if (!ws) connect(cfg)

  const state = topic(roomId)
  // If the shared connection is already authenticated (a second joinRoom()
  // call -- e.g. the module room, after the session room's connection is
  // already up), subscribe immediately. Otherwise, don't queue a subscribe
  // here at all: the auth_ok handler above already re-subscribes to every
  // topic in topicState on every (re)connect, which covers this room too
  // since it's already in topicState by the time auth_ok arrives.
  if (ready) ws.send(JSON.stringify({ type: 'subscribe', topic: roomId }))

  return {
    makeAction() {
      const sendFn = (payload, targetPeerId) =>
        send({ type: 'publish', topic: roomId, payload, targetPeerId })
      const getFn = (cb) => { state.onData = cb }
      return [sendFn, getFn]
    },
    onPeerJoin(cb)  { state.onJoin.push(cb) },
    onPeerLeave(cb) { state.onLeave.push(cb) },
    leave() {
      topicState.delete(roomId)
      if (topicState.size === 0) {
        cfgInUse = null // suppress reconnect — this is an intentional teardown
        ws?.close()
        ws = null
      }
    },
  }
}
