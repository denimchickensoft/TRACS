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

function createSyncRelay(wss, config) {
  const topics = new Map()   // topic → Set<{ws, peerId}>

  function memberOf(topic, ws) {
    for (const m of topics.get(topic) ?? []) {
      if (m.ws === ws) return m
    }
    return null
  }

  function subscribe(topic, ws, peerId) {
    let members = topics.get(topic)
    if (!members) { members = new Set(); topics.set(topic, members) }
    if (memberOf(topic, ws)) return // already subscribed — ignore duplicate

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
}

module.exports = { createSyncRelay }
