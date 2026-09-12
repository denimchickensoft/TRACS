'use strict'

// Relay-hosted Tacview client — connects OUT to a TRACS relay's /tacview
// capability (same pattern as srs.js connecting to /transponders), receiving
// already-parsed ACMI deltas instead of parsing the wire protocol itself.
// Unlike srs.js's enrichment-only role (drop updates for unknown units),
// this module IS the primary source of truth for units when relay-hosted
// Tacview is active — it creates/updates/removes units, same as tacview.js
// does for direct mode.
//
// Detection enrichment (tacviewDetection.js) and theatre bbox-voting run
// here, per-controller-backend, not inside the relay's tacview.js — see
// resources/specs/data-sources/custom-datasource-tacview-spec.md §0.1/§7 for
// why (the relay isn't meant to bundle theatre-specific terrain data).
//
// Dispatched via the "Relay Port filled, Source Port blank" branch in
// routes/api.js — not a sourceRegistry entry (see
// dataminer-architecture-placeholder-spec.md §4 for the shared dispatch slot).

const WebSocket = require('ws')
const state = require('./state')
const navdata = require('../navdata')
const tacviewDetection = require('./tacviewDetection')

const RECONNECT_MS = 3000
// See tacview.js's identical constant for why this was shortened from 5000.
const THEATRE_VOTE_WINDOW_MS = 2000
const DETECTION_INTERVAL_MS = 2000
// See tacview.js's identical constant — re-syncs useMissionClock() against
// client-side timer drift, same as Olympus's own repeated mission poll.
const MISSION_CLOCK_INTERVAL_MS = 10000
// Browser-facing broadcast cadence, matching Olympus's 1Hz poll and
// tacview.js's direct-mode equivalent — see that file's BROADCAST_INTERVAL_MS
// comment for why this throttle exists at all. Not currently configurable.
const BROADCAST_INTERVAL_MS = 1000

let ws = null
let onUnitsDelta = null
let onMission = null
let onBullseyes = null
let relayUrl = null
let password = null
let coalition = null
let intentionalClose = false
let reconnectTimer = null
let detectionTimer = null
let theatreTimer = null
let missionClockTimer = null
let theatreDecided = false
let theatreName = null
const theatreVotes = new Map()
// From the relay's own parser (this module never sees the raw ACMI wire
// itself) — see relay/tacview.js's broadcast()/onAuthenticated for where
// this rides in on every message.
let latestMissionUtcMs = null

// Omniscient truth (all coalitions) — never exposed via `state` directly.
// See tacviewDetection.js's createFogFilter / server/src/tacview.js (direct
// mode carries the identical split) for why.
let internalUnits = {}
let fogFilter = null
// Promoted out of start() — connect()'s reconnect path and the
// tacviewDetectionConfig message handler both need to read this, not just
// the initial start() call.
let friendlyCoalitionId = null

// Accumulates at full stream rate (whatever the relay forwards); flushed to
// state/broadcast at BROADCAST_INTERVAL_MS by flushBroadcast(). Mirrors
// tacview.js's identical mechanism for direct mode.
let pendingUpdated = {}
let pendingRemoved = new Set()
let broadcastTimer = null

function queueBroadcast(updated, removed) {
  for (const [id, unit] of Object.entries(updated)) {
    pendingUpdated[id] = unit
    pendingRemoved.delete(id)
  }
  for (const id of removed) {
    delete pendingUpdated[id]
    pendingRemoved.add(id)
  }
}

function flushBroadcast() {
  if (Object.keys(pendingUpdated).length === 0 && pendingRemoved.size === 0) return
  const delta = { updated: pendingUpdated, removed: [...pendingRemoved], time: Date.now() }
  state.applyDelta(delta)
  if (onUnitsDelta) onUnitsDelta(delta)
  pendingUpdated = {}
  pendingRemoved = new Set()
}

function voteTheatre(positions) {
  if (theatreDecided) return
  for (const { lat, lng } of positions) {
    for (const name of navdata.theatresContaining(lat, lng)) {
      theatreVotes.set(name, (theatreVotes.get(name) ?? 0) + 1)
    }
  }
}

// See tacview.js's identical helper for the full real-UTC-vs-DCS-internal-
// Zulu explanation — this mirrors it exactly, just sourcing missionUtcMs from
// the relay's messages instead of a local parser.
function computeDateAndTime(missionUtcMs, offsetHours) {
  const d = new Date(missionUtcMs + offsetHours * 3600000)
  return {
    date: { Day: d.getUTCDate(), Month: d.getUTCMonth() + 1, Year: d.getUTCFullYear() },
    time: { h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds() },
  }
}

function sendMissionClock() {
  if (!theatreDecided) return
  const dateAndTime = latestMissionUtcMs == null ? undefined : computeDateAndTime(latestMissionUtcMs, navdata.theatreTacviewRealUtcOffset(theatreName))
  const mission = { mission: { theatre: theatreName, dateAndTime } }
  state.setMission(mission)
  if (onMission) onMission(mission)
}

function finalizeTheatre() {
  if (theatreDecided) return
  // No votes yet -- unlike Olympus's continuously-repolled mission fetch,
  // this used to be a one-shot timer that gave up permanently on a slow or
  // momentarily idle feed. Keep trying instead of stranding detection.
  if (!theatreVotes.size) {
    theatreTimer = setTimeout(finalizeTheatre, THEATRE_VOTE_WINDOW_MS)
    return
  }
  const [best] = [...theatreVotes.entries()].sort((a, b) => b[1] - a[1])[0]
  theatreDecided = true
  theatreName = best
  sendMissionClock()
}

function runDetectionPass() {
  if (!isConnected() || !fogFilter) return
  const { contactsUpdate, revealed, hidden } = fogFilter.computeVisibility(internalUnits)
  const updated = { ...contactsUpdate, ...revealed }
  if (Object.keys(updated).length === 0 && hidden.length === 0) return
  queueBroadcast(updated, hidden)
}

function applyTacviewData(data) {
  const { updated = {}, removed = [], bullseyes = null, positions = [] } = data ?? {}

  if (positions.length) voteTheatre(positions)

  Object.assign(internalUnits, updated)
  for (const id of removed) {
    delete internalUnits[id]
    if (fogFilter) fogFilter.forget(id)
  }

  // friendlyCoalitionId === null means GM/Admin (no filter ever wanted, see
  // tacviewDetection.coalitionId) — unchanged full passthrough. A real
  // coalition with fogFilter still null means detection config hasn't
  // arrived from the relay yet (see the tacviewDetectionConfig handler in
  // connect() below) — drop rather than leak the unfiltered feed for that
  // window, unlike the GM/Admin case.
  const publicUpdated = friendlyCoalitionId === null
    ? updated
    : fogFilter
      ? fogFilter.filterFrameUpdate(updated)
      : {}

  if (Object.keys(publicUpdated).length || removed.length) {
    queueBroadcast(publicUpdated, removed)
  }

  if (bullseyes) {
    state.setBullseyes(bullseyes)
    if (onBullseyes) onBullseyes(bullseyes)
  }
}

function connect() {
  // Re-arms the wait-for-relay-config gate on every (re)connect, including
  // reconnects — the relay resends tacviewDetectionConfig fresh to every
  // newly-authenticated client, and a fresh session shouldn't assume a prior
  // one's exposedEnemyIds state still holds. Left untouched for GM/Admin
  // (friendlyCoalitionId === null), which never uses a fogFilter at all.
  if (friendlyCoalitionId !== null) fogFilter = null

  const url = `${relayUrl.replace(/\/+$/, '')}/tacview`
  // Every handler below closes over `socket` (this specific instance), never
  // the mutable module-level `ws` -- a rapid stop()/start() can reassign `ws`
  // to a newer socket in the gap between this one's handshake completing and
  // its 'open' handler actually running, and reading `ws` at that point would
  // operate on the wrong (newer, still-CONNECTING) socket instead of the one
  // that just fired the event -- exactly what crashed the process with
  // "WebSocket is not open: readyState 0 (CONNECTING)". The `socket !== ws`
  // guards additionally drop events from a socket that's since been
  // superseded, rather than letting a stale connection's data/reconnect-timer
  // race a newer one.
  const socket = new WebSocket(url)
  ws = socket

  socket.on('open', () => {
    if (socket !== ws) { socket.close(); return }
    console.log(`[tacviewRelayClient] connected to relay at ${url}`)
    socket.send(JSON.stringify({ type: 'auth', coalition, password }))
  })

  socket.on('message', (raw) => {
    if (socket !== ws) return
    let msg
    try {
      msg = JSON.parse(raw.toString('utf8'))
    } catch (err) {
      console.error('[tacviewRelayClient] failed to parse relay message:', err.message)
      return
    }
    if (msg.type === 'tacviewDetectionConfig') {
      // Relay-authoritative detection/fog-of-war tuning — see
      // server/src/tacviewDetection.js's applyRelayConfig() and
      // relay/tacview.js's onAuthenticated(). Sent once per authenticated
      // connection, even when the relay operator has no custom config file
      // (an empty {}) — GM/Admin never reaches this branch's fogFilter
      // creation (friendlyCoalitionId stays null for that role), matching
      // direct mode's identical godmode behavior.
      tacviewDetection.applyRelayConfig(msg.config)
      if (friendlyCoalitionId !== null && !fogFilter) {
        fogFilter = tacviewDetection.createFogFilter(friendlyCoalitionId)
        // Catch up on anything already accumulated into internalUnits while
        // waiting for this message, rather than waiting for the next raw
        // relay delta to trigger filterFrameUpdate naturally.
        const catchUp = fogFilter.filterFrameUpdate(internalUnits)
        if (Object.keys(catchUp).length) queueBroadcast(catchUp, [])
        runDetectionPass()
      }
      return
    }
    if (msg.type === 'tacview') {
      if (msg.missionUtcMs !== undefined) latestMissionUtcMs = msg.missionUtcMs
      applyTacviewData(msg.data)
    }
  })

  socket.on('close', (code, reason) => {
    if (socket !== ws) return
    if (intentionalClose) return

    if (reason?.toString() === 'invalid password') {
      console.error('[tacviewRelayClient] relay rejected our password — not retrying until reconnected with a corrected one')
      ws = null
      return
    }

    console.log(`[tacviewRelayClient] disconnected from relay (code ${code}${reason?.length ? `, reason: ${reason}` : ''}) — reconnecting in ${RECONNECT_MS}ms`)
    reconnectTimer = setTimeout(connect, RECONNECT_MS)
  })

  socket.on('error', (err) => {
    if (socket !== ws) return
    console.error(`[tacviewRelayClient] relay connection error: ${err.code ?? err.name ?? 'unknown'} — ${err.message || '(no message)'} — url: ${url}`)
  })
}

function start(cfg, callbacks = {}) {
  if (ws) stop()

  relayUrl = cfg.relayUrl
  password = cfg.password ?? null
  coalition = cfg.coalition ?? null
  onUnitsDelta = callbacks.onUnitsDelta ?? null
  onMission = callbacks.onMission ?? null
  onBullseyes = callbacks.onBullseyes ?? null
  intentionalClose = false
  theatreDecided = false
  theatreName = null
  theatreVotes.clear()
  latestMissionUtcMs = null
  state.resetForNewSource()
  internalUnits = {}
  pendingUpdated = {}
  pendingRemoved = new Set()
  friendlyCoalitionId = tacviewDetection.coalitionId(cfg.coalition)
  fogFilter = null
  // Baseline while waiting for the relay's own tacviewDetectionConfig
  // message (see the message handler in connect() above) — never the local
  // server/tacviewDetectionConfig.json file, which relay-hosted mode must
  // not consult at all (the relay operator, not the connecting controller,
  // owns this in this mode).
  tacviewDetection.resetToDefaults()

  connect()
  theatreTimer = setTimeout(finalizeTheatre, THEATRE_VOTE_WINDOW_MS)
  detectionTimer = setInterval(runDetectionPass, DETECTION_INTERVAL_MS)
  broadcastTimer = setInterval(flushBroadcast, BROADCAST_INTERVAL_MS)
  missionClockTimer = setInterval(sendMissionClock, MISSION_CLOCK_INTERVAL_MS)
}

function stop() {
  intentionalClose = true
  clearTimeout(reconnectTimer)
  clearTimeout(theatreTimer)
  clearInterval(detectionTimer)
  clearInterval(broadcastTimer)
  clearInterval(missionClockTimer)
  reconnectTimer = null
  if (ws) {
    ws.close()
    ws = null
  }
  onUnitsDelta = null
  onMission = null
  onBullseyes = null
  internalUnits = {}
  fogFilter = null
  pendingUpdated = {}
  pendingRemoved = new Set()
  console.log('[tacviewRelayClient] stopped')
}

// See tacview.js's identical overrideTheatre/resetTheatreDetection for the
// full rationale — these mirror them exactly for the relay-hosted-primary
// connection mode.
function overrideTheatre(name) {
  clearTimeout(theatreTimer)
  theatreDecided = true
  theatreName = name
  theatreVotes.clear()
  sendMissionClock()
}

function resetTheatreDetection() {
  clearTimeout(theatreTimer)
  theatreDecided = false
  theatreName = null
  theatreVotes.clear()
  theatreTimer = setTimeout(finalizeTheatre, THEATRE_VOTE_WINDOW_MS)
}

function isConnected() {
  return ws !== null && ws.readyState === WebSocket.OPEN
}

function getConfig() {
  return relayUrl ? { relayUrl, password, coalition } : null
}

// Marks a rejection with a specific, surfaceable reason -- mirrors
// tacview.js's identical identifiedError(), which routes/api.js already
// knows how to distinguish from a generic/unidentified failure.
function identifiedError(message) {
  return Object.assign(new Error(message), { identified: true })
}

// Throwaway probe -- validates relay reachability + coalition/password
// *before* committing to a live connection, same role tacview.js's own
// probe() plays for the direct-source path. start() itself is fire-and-
// forget (connects in the background, retries on its own timer) and was
// never checked by routes/api.js's usingRelayAsPrimary dispatch before this
// -- a rejected password there used to return {ok:true} regardless, since
// nothing ever awaited the connection's actual outcome, leaving a signed-in
// controller with a connect() that "succeeded" but no live Tacview data.
async function probe(cfg) {
  const url = `${cfg.relayUrl.replace(/\/+$/, '')}/tacview`
  await new Promise((resolve, reject) => {
    const probeSocket = new WebSocket(url)
    let settled = false

    const settle = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      probeSocket.close()
      fn(arg)
    }

    const timeout = setTimeout(() => {
      settle(reject, new Error('Relay probe timed out — no response'))
    }, 5000)

    probeSocket.on('open', () => {
      probeSocket.send(JSON.stringify({ type: 'auth', coalition: cfg.coalition, password: cfg.password }))
    })

    probeSocket.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString('utf8')) } catch { return }
      if (msg.type === 'auth_ok') settle(resolve)
    })

    probeSocket.on('close', (code, reason) => {
      settle(reject, reason?.toString() === 'invalid password'
        ? identifiedError('Relay rejected the connection — check the coalition password')
        : new Error('Relay closed the connection before authenticating'))
    })

    probeSocket.on('error', (err) => {
      settle(reject, err)
    })
  })
}

module.exports = { start, stop, isConnected, getConfig, probe, overrideTheatre, resetTheatreDetection }
