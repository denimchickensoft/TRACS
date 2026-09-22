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

import { PROTOCOL_VERSION } from './protocolVersion'

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
export function checkSyncCapable({ relayUrl, coalition, password }) {
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
      ws.send(JSON.stringify({ type: 'auth', coalition, password, peerId: CAPABILITY_CHECK_ID, protocolVersion: PROTOCOL_VERSION }))
    }
    ws.onmessage = (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.type === 'auth_ok') finish({ capable: true })
    }
    ws.onclose = (ev) => {
      finish({
        capable: false,
        reason: ev.reason === 'invalid password' ? 'password'
              : ev.reason?.startsWith('protocol mismatch') ? 'protocol'
              : 'unreachable',
        detail: ev.reason,
      })
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

// Populated from the relay's auth_ok ack once connected — read by the
// settings gear menu to display Relay's version/protocol alongside TRACS's
// own (see production-spec.md §8's version-display decision). null fields
// mean "not connected to a relay this session".
export const relayInfo = { version: null, protocolVersion: null }

let ws           = null
let ready        = false
let readyQueue   = []
let cfgInUse     = null
const topicState = new Map()   // topic → { onData: fn|null, onJoin: [fn], onLeave: [fn] }

function topic(t) {
  let s = topicState.get(t)
  if (!s) { s = { onData: null, onJoin: [], onLeave: [], onRegistryUpdate: [], pendingRegister: null }; topicState.set(t, s) }
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
    ws.send(JSON.stringify({ type: 'auth', coalition: cfg.coalition, password: cfg.password, peerId: selfId, protocolVersion: PROTOCOL_VERSION }))
  }

  ws.onmessage = (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }

    if (msg.type === 'auth_ok') {
      ready = true
      relayInfo.version         = msg.relayVersion ?? null
      relayInfo.protocolVersion = msg.protocolVersion ?? null
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
      return
    }

    // Registry-authority messages (client.js's Bug-2 relay-authority path) —
    // the relay resolves position collisions and mints controllerIds itself
    // on this transport, see relay/syncRelay.js's handleRegister().
    if (msg.type === 'register_rejected' && topicState.has(msg.topic)) {
      const state = topicState.get(msg.topic)
      state.pendingRegister?.({
        rejected: true, reason: msg.reason,
        conflictPosition: msg.conflictPosition, frequency: msg.frequency,
      })
      state.pendingRegister = null
      return
    }
    if (msg.type === 'registry_update' && topicState.has(msg.topic)) {
      const state = topicState.get(msg.topic)
      // Sent to every member of the topic, including whoever just
      // registered (unlike 'publish', which excludes the sender) — it's
      // self-consistent to apply regardless of who triggered it.
      if (state.pendingRegister) {
        state.pendingRegister({ rejected: false })
        state.pendingRegister = null
      }
      const payload = {
        clientList:       msg.clientList,
        registry:         msg.registry,
        groupAssignments: msg.groupAssignments,
        nextGroupNumber:  msg.nextGroupNumber,
      }
      for (const cb of state.onRegistryUpdate) cb(payload)
    }
  }

  ws.onclose = (ev) => {
    ready = false
    relayInfo.version         = null
    relayInfo.protocolVersion = null
    if (!cfgInUse) return // intentional teardown (leave() cleared it) — no reconnect

    // A password rejection won't resolve itself by retrying (same reasoning
    // as server/src/srs.js's identical guard) -- this shouldn't normally
    // happen, since Login's ConnectPhase already validated the password
    // before initWebrtc() ever selects this transport, but a relay
    // reconfigured mid-session is a real enough edge case to not loop on.
    if (ev.reason === 'invalid password') {
      console.error('[sync] relay rejected our password - not retrying')
      cfgInUse = null
      ws = null
      return
    }
    if (ev.reason?.startsWith('protocol mismatch')) {
      console.error(`[sync] ${ev.reason} - not retrying until one side is updated`)
      cfgInUse = null
      ws = null
      return
    }

    console.warn(`[sync] disconnected from relay - reconnecting in ${RECONNECT_MS}ms`)
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
    // Registers this peer with the relay's registry authority for this topic
    // (session-topic only — see client.js's Bug-2 relay-authority path) and
    // resolves once the relay answers, either with the resolved registration
    // (via a registry_update, applied through onRegistryUpdate below same as
    // any other) or a rejection. Only one registerSelf() call is ever made
    // per room join, so a single pending resolver per topic is sufficient.
    registerSelf(info) {
      return new Promise((resolve) => {
        state.pendingRegister = resolve
        send({ type: 'register', topic: roomId, ...info })
      })
    },
    // Fires on every registry_update for this topic — the relay's
    // authoritative clientList/registry/groupAssignments/nextGroupNumber,
    // both the initial answer to registerSelf() and every subsequent change
    // (another controller joining/leaving/reconnecting).
    onRegistryUpdate(cb) { state.onRegistryUpdate.push(cb) },
    leave() {
      topicState.delete(roomId)
      if (topicState.size === 0) {
        cfgInUse = null // suppress reconnect — this is an intentional teardown
        ws?.close()
        ws = null
        // Mint a fresh peerId on the next joinRoom() rather than reusing this
        // one -- reusing it raced the relay's close-triggered eviction timer
        // against the new registration's cancelEvictionTimer (arrival order
        // of the two isn't guaranteed across independent connections), which
        // could delete the new, correct clientList entry ~30s later.
        selfId = null
      }
    },
  }
}
