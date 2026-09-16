'use strict'

// Centralized controller-sync capability — a room-scoped, topic-based pub/sub
// hub (mounted at /sync by relay/index.js), used by browsers directly as an
// automatic substitute for the Trystero/WebRTC P2P mesh whenever this relay
// is reachable. Generalizes server/src/signalRelay.js's pattern (one
// connection, subscribe to N topics, publish fans out within a topic), with
// three additions the existing client-side WebRTC protocol depends on:
// peer-presence events, self-broadcast exclusion, and targeted send.
//
// See resources/specs/data-sources/webrtc-centralized-sync-spec.md §2.
const { gateConnection } = require('./auth')

// How often to ping every connected socket, and how a missed pong is
// detected: any socket still marked not-alive at the START of a tick (i.e.
// it never answered the ping sent on the PREVIOUS tick) is presumed dead
// and terminated. So a truly dead connection is reaped within one to two
// intervals of going quiet, not left registered in `topics` forever (the
// gap that let a stale session hold a position name hostage indefinitely --
// see resources/specs/data-sources/webrtc-centralized-sync-spec.md).
const HEARTBEAT_INTERVAL_MS = 20_000

function createSyncRelay(wss, config) {
  const topics = new Map()   // topic → Set<{ws, peerId}>

  function memberOf(topic, ws) {
    for (const m of topics.get(topic) ?? []) {
      if (m.ws === ws) return m
    }
    return null
  }

  function memberByPeerId(topic, peerId) {
    for (const m of topics.get(topic) ?? []) {
      if (m.peerId === peerId) return m
    }
    return null
  }

  function subscribe(topic, ws, peerId) {
    let members = topics.get(topic)
    if (!members) { members = new Set(); topics.set(topic, members) }
    if (memberOf(topic, ws)) return // already subscribed — ignore duplicate

    // Reconnect under the same peerId (e.g. a brief drop-and-retry on the
    // flat 3s reconnect in syncClient.js) — replace the stale socket in
    // place rather than adding a second membership entry. Without this, the
    // stale entry lingers until the heartbeat sweep reaps it, up to
    // HEARTBEAT_INTERVAL_MS*2 later, and unsubscribeAll() then broadcasts a
    // peer_leave for a peerId that, from every other member's perspective,
    // never actually left — client.js has no way to distinguish that from a
    // real departure.
    const existing = memberByPeerId(topic, peerId)
    if (existing) {
      existing.ws = ws
      console.log(`[relay:sync] peerId=${peerId} resubscribed topic=${topic} (${members.size} member${members.size === 1 ? '' : 's'})`)
      return
    }

    // Notify existing members about the newcomer, and the newcomer about each
    // existing member — symmetric on both sides, matching Trystero's onPeerJoin,
    // which fires for every pairing regardless of which side joined the mesh
    // later. Without the second loop, a joining peer never learns who's already
    // in the room and never sends its own HANDSHAKE (client.js), so the two
    // sides never discover each other.
    const joinMsg = JSON.stringify({ type: 'peer_join', topic, peerId })
    for (const m of members) {
      if (m.ws.readyState === m.ws.OPEN) m.ws.send(joinMsg)
    }
    for (const m of members) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'peer_join', topic, peerId: m.peerId }))
    }
    members.add({ ws, peerId })
    console.log(`[relay:sync] peerId=${peerId} joined topic=${topic} (${members.size} member${members.size === 1 ? '' : 's'})`)
  }

  // Called on every connection close, whatever the cause — a clean leave()
  // teardown, a page refresh/navigation tearing down the socket, or a real
  // network drop all look the same from here: the socket just closed.
  function unsubscribeAll(ws) {
    let leftAny = false
    for (const [topic, members] of topics) {
      const mine = memberOf(topic, ws)
      if (!mine) continue
      leftAny = true
      members.delete(mine)
      if (members.size === 0) {
        topics.delete(topic)
        console.log(`[relay:sync] peerId=${mine.peerId} left topic=${topic} (0 members, topic removed)`)
        continue
      }
      console.log(`[relay:sync] peerId=${mine.peerId} left topic=${topic} (${members.size} member${members.size === 1 ? '' : 's'} remaining)`)
      const leaveMsg = JSON.stringify({ type: 'peer_leave', topic, peerId: mine.peerId })
      for (const m of members) {
        if (m.ws.readyState === m.ws.OPEN) m.ws.send(leaveMsg)
      }
    }
    if (!leftAny) console.log('[relay:sync] connection closed before subscribing to anything')
  }

  function publish(topic, payload, fromWs, targetPeerId) {
    const members = topics.get(topic)
    if (!members) return

    if (targetPeerId) {
      for (const m of members) {
        if (m.peerId === targetPeerId && m.ws.readyState === m.ws.OPEN) {
          m.ws.send(JSON.stringify({ type: 'publish', topic, payload }))
        }
      }
      return
    }

    // Fan out to every OTHER member — never echo a broadcast back to its own
    // sender, unlike signalRelay.js's simpler topic broadcast. client.js's
    // message handlers aren't written to tolerate receiving their own
    // messages (e.g. a self-HANDSHAKE would be nonsensical).
    const msg = JSON.stringify({ type: 'publish', topic, payload })
    for (const m of members) {
      if (m.ws === fromWs) continue
      if (m.ws.readyState === m.ws.OPEN) m.ws.send(msg)
    }
  }

  wss.on('connection', (ws) => {
    let peerId = null
    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })

    gateConnection(ws, config.passwords, {
      label: 'sync',
      onAuthenticated: (authMsg) => {
        peerId = authMsg.peerId ?? null
        console.log(`[relay:sync] client authenticated coalition=${authMsg.coalition} peerId=${peerId}`)
      },
    })

    ws.on('message', (raw) => {
      if (!peerId) return // not authenticated yet — auth.js owns this message

      let msg
      try {
        msg = JSON.parse(raw.toString('utf8'))
      } catch (err) {
        console.error('[relay:sync] failed to parse client message:', err.message)
        return
      }

      if (msg.type === 'subscribe' && typeof msg.topic === 'string') {
        subscribe(msg.topic, ws, peerId)
      } else if (msg.type === 'publish' && typeof msg.topic === 'string') {
        publish(msg.topic, msg.payload, ws, msg.targetPeerId)
      }
    })

    ws.on('close', () => {
      console.log(`[relay:sync] connection closed peerId=${peerId}`)
      unsubscribeAll(ws)
    })

    ws.on('error', (err) => {
      if (err.code === 'ECONNRESET') return
      console.error('[relay:sync] client socket error:', err.message)
    })
  })

  // Reap connections that stopped answering pings -- a dead TCP connection
  // (process killed, sleep/wake, network drop) otherwise never fires 'close'
  // and sits in `topics` forever, holding its position name hostage against
  // a legitimate reconnect. terminate() forces 'close', which routes through
  // the existing unsubscribeAll(ws) cleanup above -- no separate reap logic
  // needed.
  const heartbeatInterval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue }
      ws.isAlive = false
      ws.ping()
    }
  }, HEARTBEAT_INTERVAL_MS)
  wss.on('close', () => clearInterval(heartbeatInterval))
}

module.exports = { createSyncRelay }
