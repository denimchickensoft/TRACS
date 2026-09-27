'use strict'

// Centralized controller-sync capability — a room-scoped, topic-based pub/sub
// hub (mounted at /sync by relay/index.js), used by browsers directly as an
// automatic substitute for the Trystero/WebRTC P2P mesh whenever this relay
// is reachable. Generalizes server/src/signalRelay.js's pattern (one
// connection, subscribe to N topics, publish fans out within a topic), with
// three additions the existing client-side WebRTC protocol depends on:
// peer-presence events, self-broadcast exclusion, and targeted send.
const fs   = require('fs')
const path = require('path')
const { gateConnection } = require('./auth')
const { resolvePosition, mintEntry } = require('./registryAuthority')
const { RELAY_DIR } = require('./paths')

// How often to ping every connected socket, and how a missed pong is
// detected: any socket still marked not-alive at the START of a tick (i.e.
// it never answered the ping sent on the PREVIOUS tick) is presumed dead
// and terminated. So a truly dead connection is reaped within one to two
// intervals of going quiet, not left registered in `topics` forever (the
// gap that would let a stale session hold a position name hostage
// indefinitely).
const HEARTBEAT_INTERVAL_MS = 15_000

// Registry-authority state (the relay assigns positions/controller IDs in
// relay mode; see registryAuthority.js). Session-topic-only:
// a topic only ever gains a `sessions` entry once a client sends it a
// `register` message, so this never applies to module-room topics, which
// keep using the plain `topics` pub/sub above unchanged. Matches client.js's
// DISCONNECT_TIMEOUT_MS so a brief drop/refresh gets the same reconnect
// grace on both sides before a position/letter is actually freed.
const SESSION_DISCONNECT_TIMEOUT_MS = 5_000
const SESSIONS_FILE          = path.join(RELAY_DIR, 'sessions.json')
const PERSIST_DEBOUNCE_MS    = 500

function createSyncRelay(wss, config) {
  const topics = new Map()   // topic → Set<{ws, peerId}>

  // topic → { clientList, registry, groupAssignments, nextGroupNumber, evictionTimers }
  // A session's on-disk record is deleted the instant its last member's
  // eviction window expires with no reconnect (see startEvictionTimer below)
  // — persistence only ever protects a genuinely *active* session against a
  // mid-session relay restart, it never outlives the session itself.
  const sessions = new Map()
  let persistTimer = null

  function persistSessionsDebounced() {
    clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      const plain = {}
      for (const [topic, session] of sessions) {
        plain[topic] = {
          clientList:       session.clientList,
          registry:         session.registry,
          groupAssignments: session.groupAssignments,
          nextGroupNumber:  session.nextGroupNumber,
        }
      }
      fs.writeFile(SESSIONS_FILE, JSON.stringify(plain), (err) => {
        if (err) console.error('[relay:sync] failed to persist sessions:', err.message)
      })
    }, PERSIST_DEBOUNCE_MS)
  }

  // Every entry loaded from disk starts inside its eviction window (same as
  // a live entry whose socket just closed) rather than being treated as
  // live -- a genuine reconnect (matched by clientId+position in
  // handleRegister's stale-slot eviction, same as a live disconnect) reclaims
  // its identity within the grace window; anything that doesn't reconnect in
  // time is pruned by the same eviction-timer path already used for a live
  // disconnect.
  function loadPersistedSessions() {
    let raw
    try {
      raw = fs.readFileSync(SESSIONS_FILE, 'utf8')
    } catch {
      return // no persisted state yet -- normal on first run
    }
    let plain
    try {
      plain = JSON.parse(raw)
    } catch (err) {
      console.error('[relay:sync] failed to parse persisted sessions, starting fresh:', err.message)
      return
    }
    for (const [topic, saved] of Object.entries(plain)) {
      sessions.set(topic, {
        clientList:       saved.clientList ?? [],
        registry:         saved.registry ?? {},
        groupAssignments: saved.groupAssignments ?? {},
        nextGroupNumber:  saved.nextGroupNumber ?? 1,
        evictionTimers:   {},
      })
      const session = sessions.get(topic)
      for (const client of session.clientList) startEvictionTimer(topic, client.peerId)
      console.log(`[relay:sync] restored persisted session ${topic} (${session.clientList.length} member(s), all pending reconnect)`)
    }
  }

  function cancelEvictionTimer(session, peerId) {
    if (session.evictionTimers[peerId]) {
      clearTimeout(session.evictionTimers[peerId])
      delete session.evictionTimers[peerId]
    }
  }

  function startEvictionTimer(topic, peerId) {
    const session = sessions.get(topic)
    if (!session) return
    cancelEvictionTimer(session, peerId)
    session.evictionTimers[peerId] = setTimeout(() => {
      delete session.evictionTimers[peerId]
      const entry = session.clientList.find((c) => c.peerId === peerId)
      if (!entry) return

      session.clientList = session.clientList.filter((c) => c.peerId !== peerId)
      // Only drop the registry entry if no OTHER clientList member still
      // holds that exact position (mirrors client.js's dropControllerTracks
      // "still active" guard for the analogous controllerId case, applied
      // here at the position level).
      if (!session.clientList.some((c) => c.position === entry.position)) {
        const nextRegistry = { ...session.registry }
        delete nextRegistry[entry.position]
        session.registry = nextRegistry
      }

      if (session.clientList.length === 0) {
        sessions.delete(topic)
        console.log(`[relay:sync] session ${topic} fully departed - registry record deleted`)
      } else {
        broadcastRegistryUpdate(topic)
      }
      persistSessionsDebounced()
    }, SESSION_DISCONNECT_TIMEOUT_MS)
  }

  // Called on every connection close (see wss.on('connection') below) —
  // finds every session this peerId was registered to (in practice at most
  // one: a browser tab joins exactly one session room per sign-on) and
  // starts its reconnect-grace eviction timer, mirroring client.js's
  // sessionRoom.onPeerLeave -> startDisconnectTimer.
  function handleSessionDisconnect(peerId) {
    for (const [topic, session] of sessions) {
      if (session.clientList.some((c) => c.peerId === peerId)) startEvictionTimer(topic, peerId)
    }
  }

  function effectivePositions(session, excludePeerId) {
    return session.clientList
      .filter((c) => c.peerId !== excludePeerId && !session.evictionTimers[c.peerId])
      .map((c) => c.position)
  }

  function upsertSessionClient(session, entry) {
    session.clientList = [...session.clientList.filter((c) => c.peerId !== entry.peerId), entry]
      .sort((a, b) => a.connectedAt - b.connectedAt)
  }

  function broadcastRegistryUpdate(topic) {
    const session = sessions.get(topic)
    const members = topics.get(topic)
    if (!session || !members) return
    const msg = JSON.stringify({
      type: 'registry_update', topic,
      clientList:       session.clientList,
      registry:         session.registry,
      groupAssignments: session.groupAssignments,
      nextGroupNumber:  session.nextGroupNumber,
    })
    // Every current member, including whoever just registered -- unlike
    // publish()'s sender-exclusion, this is self-consistent to apply
    // regardless of who triggered it (client.js's onRegistryUpdate handler
    // relies on this to get its own resolved position back).
    for (const m of members) {
      if (m.ws.readyState === m.ws.OPEN) m.ws.send(msg)
    }
  }

  // The relay's sole entry point for registry authority — replaces the
  // client-side amGlobalHost branch of client.js's HANDSHAKE handler for
  // this transport. Ported step-for-step from that handler: stale-slot
  // eviction, frequency deconfliction, position resolution, upsert,
  // mint-if-not-already-registered, broadcast.
  // Shape check for a client-supplied `register` message. The real client
  // always sends these types; anything else is a malformed or hand-crafted
  // message and must be rejected before it reaches resolvePosition/mintEntry
  // (a non-string position, for one, throws inside resolvePosition).
  const isOptString = (v) => v == null || typeof v === 'string'
  const isOptNumber = (v) => v == null || (typeof v === 'number' && Number.isFinite(v))
  function isValidRegister(msg) {
    return typeof msg.position === 'string' && msg.position.length > 0
      && isOptString(msg.clientId) && isOptString(msg.previousPeerId)
      && isOptString(msg.module) && isOptString(msg.facility) && isOptString(msg.suffix)
      && (isOptString(msg.frequency) || isOptNumber(msg.frequency))
      && isOptNumber(msg.connectedAt) && isOptNumber(msg.roomJoinedAt)
      && isOptString(msg.preferredLetter) && isOptString(msg.displayName)
      && (msg.canAssumeTrack == null || typeof msg.canAssumeTrack === 'boolean')
  }

  function handleRegister(topic, ws, peerId, msg) {
    if (!isValidRegister(msg)) {
      console.error(`[relay:sync] rejecting malformed register from peerId=${peerId} topic=${topic}`)
      ws.send(JSON.stringify({ type: 'register_rejected', topic, reason: 'INVALID_REGISTRATION' }))
      return
    }

    let session = sessions.get(topic)
    if (!session) {
      session = { clientList: [], registry: {}, groupAssignments: {}, nextGroupNumber: 1, evictionTimers: {} }
      sessions.set(topic, session)
    }

    // Stale-slot eviction -- port of client.js's HANDSHAKE handler: same-tab
    // refresh via previousPeerId, same-device re-sign-on via clientId+position.
    if (msg.previousPeerId) {
      cancelEvictionTimer(session, msg.previousPeerId)
      session.clientList = session.clientList.filter((c) => c.peerId !== msg.previousPeerId)
    }
    if (msg.clientId) {
      const stale = session.clientList.find((c) => c.clientId === msg.clientId && c.position === msg.position)
      if (stale) {
        cancelEvictionTimer(session, stale.peerId)
        session.clientList = session.clientList.filter((c) => c.peerId !== stale.peerId)
      }
    }
    // A genuine reconnect under the same peerId (syncClient.js's flat
    // reconnect-after-drop) -- cancel its own eviction timer if one is running.
    cancelEvictionTimer(session, peerId)

    // Frequency deconfliction -- port of client.js's HANDSHAKE handler. A
    // frequency is blocked if another position with a different
    // facility+suffix is already using it.
    if (msg.frequency) {
      const incomingFreq = parseFloat(msg.frequency).toFixed(3)
      const incomingFac  = msg.facility ?? ''
      const incomingSuf  = msg.suffix   ?? ''
      const conflict = session.clientList.find((c) => {
        if (c.peerId === peerId) return false
        if (!c.frequency) return false
        if (parseFloat(c.frequency).toFixed(3) !== incomingFreq) return false
        return c.facility !== incomingFac || c.suffix !== incomingSuf
      })
      if (conflict) {
        ws.send(JSON.stringify({
          type: 'register_rejected', topic,
          reason: 'DUPLICATE_FREQUENCY',
          conflictPosition: conflict.position,
          frequency: incomingFreq,
        }))
        return
      }
    }

    const resolved = resolvePosition(msg.position, effectivePositions(session, peerId))

    upsertSessionClient(session, {
      peerId, clientId: msg.clientId, position: resolved, module: msg.module,
      frequency:    msg.frequency ?? '',
      facility:     msg.facility  ?? '',
      suffix:       msg.suffix    ?? '',
      connectedAt:  msg.connectedAt  ?? Date.now(),
      roomJoinedAt: msg.roomJoinedAt ?? msg.connectedAt ?? Date.now(),
    })

    // Mint only if this position isn't already registered -- a reconnect
    // under the same position must never re-mint (same "no reassignment"
    // invariant as controllers.js's rebuildFromClientList).
    if (!session.registry[resolved]) {
      const minted = mintEntry({
        position: resolved,
        facility: msg.facility ?? '', suffix: msg.suffix ?? '', frequency: msg.frequency ?? '',
        hints: {
          preferredLetter: msg.preferredLetter ?? null,
          canAssumeTrack:  msg.canAssumeTrack   ?? false,
          displayName:     msg.displayName,
        },
        registry:         session.registry,
        groupAssignments: session.groupAssignments,
        nextGroupNumber:  session.nextGroupNumber,
      })
      session.registry         = { ...session.registry, [resolved]: minted.entry }
      session.groupAssignments = minted.groupAssignments
      session.nextGroupNumber  = minted.nextGroupNumber
    }

    broadcastRegistryUpdate(topic)
    persistSessionsDebounced()
  }

  loadPersistedSessions()

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
        peerId = typeof authMsg.peerId === 'string' && authMsg.peerId ? authMsg.peerId : null
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

      if (!msg || typeof msg !== 'object') return

      // Safety net: a bug or an unexpected message shape in one handler must
      // not take down the whole relay for every other connected controller.
      try {
        if (msg.type === 'subscribe' && typeof msg.topic === 'string') {
          subscribe(msg.topic, ws, peerId)
        } else if (msg.type === 'publish' && typeof msg.topic === 'string') {
          publish(msg.topic, msg.payload, ws, msg.targetPeerId)
        } else if (msg.type === 'register' && typeof msg.topic === 'string') {
          handleRegister(msg.topic, ws, peerId, msg)
        }
      } catch (err) {
        console.error(`[relay:sync] error handling '${msg.type}' from peerId=${peerId}:`, err)
      }
    })

    ws.on('close', () => {
      console.log(`[relay:sync] connection closed peerId=${peerId}`)
      unsubscribeAll(ws)
      handleSessionDisconnect(peerId)
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
