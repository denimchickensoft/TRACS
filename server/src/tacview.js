'use strict'

// Direct-mode Tacview Real-Time Telemetry source — a normal sourceRegistry
// entry, exactly like olympus.js. Each controller's TRACS backend opens its
// own TCP connection straight to Tacview's RTT port and parses the ACMI
// stream itself via the shared tacviewCore parser.
//
// See resources/specs/data-sources/custom-datasource-tacview-spec.md
// (protocol facts, §0.1 for the relay-hosted alternative mode) and
// pluggable-source-architecture-spec.md (the {start,stop,isPolling,
// getConfig,probe} contract this implements).

const net = require('net')
const state = require('./state')
const navdata = require('../navdata')
const tacviewCore = require('./tacviewCore')
const tacviewDetection = require('./tacviewDetection')

const DEFAULT_PORT = 42674
const RECONNECT_MS = 3000
// Was 5000 — never a measured minimum, just an untested comfortable margin
// (see custom-datasource-tacview-spec.md §4.2). Shortened 2026-09-06 to cut
// Login's facility-picker wait; the manual theatre override remains the real
// safety net against a border-overlap-zone misvote, not this window's length.
const THEATRE_VOTE_WINDOW_MS = 2000
const DETECTION_INTERVAL_MS = 2000
// Re-sync the mission clock this often (matches olympus.js's own
// MISSION_INTERVAL_MS) — useMissionClock() free-runs client-side off of
// whatever dateAndTime it was last given, so periodic re-sends correct any
// client-side timer drift over a long session, same as Olympus already does.
const MISSION_CLOCK_INTERVAL_MS = 10000
// Olympus polls (and therefore broadcasts to the browser) at a controlled
// 1Hz (olympus.js's POLL_INTERVAL_MS). Tacview's raw ACMI stream has no such
// throttle — it pushes at whatever rate DCS's exporter is configured for
// (~9Hz observed live) — so without this, the scope would repaint far more
// often for a Tacview-sourced connection than it ever does for Olympus.
// Incoming updates are still parsed/tracked at full stream rate internally
// (needed for the groundspeed derivation's accuracy); only the
// browser-facing broadcast is throttled to match Olympus's cadence. Not
// currently user-configurable — hard-coded to match Olympus exactly.
const BROADCAST_INTERVAL_MS = 1000
// If the server closes the connection right after our handshake (no
// telemetry ever received) this many times in a row, stop retrying — this is
// almost always a wrong RTT password, not a transient network blip, and
// probe() should already have caught it before start() was ever called; this
// is the backstop for the rare case where credentials were valid at probe
// time but not at actual connect time.
const MAX_HANDSHAKE_FAILURES = 3

let config = null
let socket = null
let parser = null
let connected = false
let intentionalClose = false
let reconnectTimer = null
let detectionTimer = null
let theatreTimer = null
let missionClockTimer = null
let theatreDecided = false
let theatreName = null
const theatreVotes = new Map()

// Omniscient truth (all coalitions) — deliberately never exposed via `state`
// directly. `state`/broadcast only ever receive the fog-filtered subset; see
// tacviewDetection.js's createFogFilter for why this split exists.
let internalUnits = {}
let fogFilter = null

let onUnitsDelta = null
let onMission = null
let onBullseyes = null
let onDisconnect = null
let handshakeFailures = 0

// Accumulates at full stream rate; flushed to state/broadcast once per
// BROADCAST_INTERVAL_MS by flushBroadcast(). Both processIncoming and
// runDetectionPass write here instead of calling state.applyDelta directly.
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

// Login.jsx's composedOlympusUrl() always builds "http://host:port"
// regardless of which source actually answers on that port (the
// olympusUrl→sourceAddress rename is deliberately deferred — see README.md's
// "Deliberately deferred" list) — so tacview.js has to parse the same field
// Olympus does.
function parseHostPort(olympusUrl) {
  const stripped = String(olympusUrl ?? '').replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  const [host, portStr] = stripped.split(':')
  return { host, port: portStr ? parseInt(portStr, 10) : DEFAULT_PORT }
}

function voteTheatre(positions) {
  if (theatreDecided) return
  for (const { lat, lng } of positions) {
    for (const name of navdata.theatresContaining(lat, lng)) {
      theatreVotes.set(name, (theatreVotes.get(name) ?? 0) + 1)
    }
  }
}

// Tacview's ReferenceTime is real-world UTC (confirmed live by its trailing
// 'Z', e.g. "2011-06-25T09:30:01Z"). DCS's own dateAndTime (what Olympus
// sends, and what useMissionClock()/toUtcDateTime() expect) is theatre-local
// relative to DCS's own INTERNAL clock — a separate thing from real-world
// UTC, skewed from it by its own fixed per-theatre amount (confirmed live,
// 2026-09-06: PersianGulf needed a real-UTC→local offset of +3.5, distinct
// from the existing +4 used for the internal-Zulu→local leg — see
// navdata.theatreTacviewRealUtcOffset()'s comment for the full story). This
// converts real UTC straight to the theatre-local shape the existing
// pipeline expects, using the Tacview-specific constant, not the Olympus one.
function computeDateAndTime(missionUtcMs, offsetHours) {
  const d = new Date(missionUtcMs + offsetHours * 3600000)
  return {
    date: { Day: d.getUTCDate(), Month: d.getUTCMonth() + 1, Year: d.getUTCFullYear() },
    time: { h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds() },
  }
}

// Sent once at theatre-finalization and then re-sent every
// MISSION_CLOCK_INTERVAL_MS so useMissionClock()'s client-side free-running
// clock gets periodically corrected, same as Olympus's own repeated
// /olympus/mission poll already does.
function sendMissionClock() {
  if (!theatreDecided) return
  const missionUtcMs = parser?.getCurrentMissionUtcMs()
  const dateAndTime = missionUtcMs == null ? undefined : computeDateAndTime(missionUtcMs, navdata.theatreTacviewRealUtcOffset(theatreName))
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
  if (!connected || !fogFilter) return
  const { contactsUpdate, revealed, hidden } = fogFilter.computeVisibility(internalUnits)
  const updated = { ...contactsUpdate, ...revealed }
  if (Object.keys(updated).length === 0 && hidden.length === 0) return
  queueBroadcast(updated, hidden)
}

let lineBuffer = ''
function processIncoming(text) {
  lineBuffer += text
  const lines = lineBuffer.split('\n')
  lineBuffer = lines.pop() ?? ''
  if (lines.length === 0) return

  const { updated, removed, bullseyes, positions } = parser.parseLines(lines)

  if (positions.length) voteTheatre(positions)

  Object.assign(internalUnits, updated)
  for (const id of removed) {
    delete internalUnits[id]
    if (fogFilter) fogFilter.forget(id)
  }

  const publicUpdated = fogFilter ? fogFilter.filterFrameUpdate(updated) : updated

  if (Object.keys(publicUpdated).length || removed.length) {
    queueBroadcast(publicUpdated, removed)
  }

  if (bullseyes) {
    state.setBullseyes(bullseyes)
    if (onBullseyes) onBullseyes(bullseyes)
  }
}

function connect() {
  const { host, port } = parseHostPort(config.olympusUrl)
  let handshakeSent = false
  let receivedTelemetry = false

  // Every handler below closes over `localSocket` (this specific instance),
  // never the mutable module-level `socket` -- a rapid stop()/connect() (two
  // overlapping /api/connect requests, or the reconnect timer firing right as
  // a fresh manual attempt starts) can reassign `socket` to a newer
  // connection while an older one's handler is still in flight, and reading
  // `socket` at that point would act on the wrong connection instead of the
  // one that actually emitted the event -- e.g. writing the RTT handshake
  // (below) onto a not-yet-connected socket. Same race class fixed the same
  // way in tacviewRelayClient.js/srs.js earlier the same day; this is
  // plausibly tangled up with the real ACCESS_VIOLATION crash documented in
  // that memory ("cross-request rapid-reconnect guard still missing"). The
  // `localSocket !== socket` guards additionally drop events from a
  // connection that's since been superseded, rather than letting a stale
  // one's data/reconnect-timer race a newer one.
  const localSocket = net.createConnection({ host, port })
  socket = localSocket

  localSocket.on('connect', () => {
    if (localSocket !== socket) { localSocket.destroy(); return }
    console.log(`[tacview] connected to ${host}:${port}`)
    connected = true
  })

  localSocket.on('data', (chunk) => {
    if (localSocket !== socket) return
    if (!handshakeSent) {
      handshakeSent = true
      localSocket.write(tacviewCore.buildClientHandshake('TRACS', config.password))
      const text = chunk.toString('utf8')
      const nullIdx = text.indexOf('\0')
      const remainder = nullIdx === -1 ? '' : text.slice(nullIdx + 1)
      if (remainder) { receivedTelemetry = true; processIncoming(remainder) }
      return
    }
    receivedTelemetry = true
    processIncoming(chunk.toString('utf8'))
  })

  localSocket.on('close', () => {
    if (localSocket !== socket) return
    connected = false
    if (intentionalClose) return

    if (receivedTelemetry) {
      handshakeFailures = 0
    } else if (++handshakeFailures >= MAX_HANDSHAKE_FAILURES) {
      console.error(`[tacview] rejected ${handshakeFailures}x in a row right after the handshake — likely a wrong RTT password. Giving up.`)
      if (onDisconnect) onDisconnect()
      return
    }

    console.log(`[tacview] disconnected — reconnecting in ${RECONNECT_MS}ms`)
    reconnectTimer = setTimeout(connect, RECONNECT_MS)
  })

  localSocket.on('error', (err) => {
    if (localSocket !== socket) return
    console.error(`[tacview] connection error: ${err.code ?? err.name ?? 'unknown'} — ${err.message || '(no message)'}`)
  })
}

function start(cfg, callbacks = {}) {
  if (socket) stop()

  config = cfg
  onUnitsDelta = callbacks.onUnitsDelta ?? null
  onMission = callbacks.onMission ?? null
  onBullseyes = callbacks.onBullseyes ?? null
  onDisconnect = callbacks.onDisconnect ?? null

  parser = tacviewCore.createParser()
  lineBuffer = ''
  intentionalClose = false
  theatreDecided = false
  theatreName = null
  theatreVotes.clear()
  state.resetForNewSource()
  internalUnits = {}
  handshakeFailures = 0
  pendingUpdated = {}
  pendingRemoved = new Set()
  // Guards against a prior relay-hosted session (tacviewRelayClient.js)
  // having left tacviewDetection's shared config sourced from a relay —
  // direct mode always forces itself back to the local file/defaults.
  tacviewDetection.resetToLocalConfig()
  const friendlyCoalitionId = tacviewDetection.coalitionId(cfg.coalition)
  fogFilter = friendlyCoalitionId !== null ? tacviewDetection.createFogFilter(friendlyCoalitionId) : null

  connect()
  theatreTimer = setTimeout(finalizeTheatre, THEATRE_VOTE_WINDOW_MS)
  detectionTimer = setInterval(runDetectionPass, DETECTION_INTERVAL_MS)
  broadcastTimer = setInterval(flushBroadcast, BROADCAST_INTERVAL_MS)
  missionClockTimer = setInterval(sendMissionClock, MISSION_CLOCK_INTERVAL_MS)
}

function stop() {
  intentionalClose = true
  connected = false
  clearTimeout(reconnectTimer)
  clearTimeout(theatreTimer)
  clearInterval(missionClockTimer)
  clearInterval(detectionTimer)
  clearInterval(broadcastTimer)
  reconnectTimer = null
  if (socket) {
    socket.destroy()
    socket = null
  }
  config = null
  internalUnits = {}
  fogFilter = null
  pendingUpdated = {}
  pendingRemoved = new Set()
  console.log('[tacview] stopped')
}

// Manual override from Login.jsx's Theatre control — a controller directly
// asserting the theatre beats the bbox-vote outright (it's the intended
// escape hatch for exactly the cases the vote can't resolve on its own: the
// unbreakable MarianaIslands/MarianaIslandsWWII tie, or a border-overlap
// misvote). Cancelling theatreTimer stops the pending auto-vote result from
// clobbering this a few seconds later; latching theatreDecided keeps it stuck
// for the rest of this connection, same as a normal vote result would.
function overrideTheatre(name) {
  clearTimeout(theatreTimer)
  theatreDecided = true
  theatreName = name
  theatreVotes.clear()
  sendMissionClock()
}

// Undo an override (or a bad initial auto-vote) without touching the live
// Tacview connection — routes/api.js's alreadyOnSameSource skip means a
// browser relogin never restarts it (a genuine restart risks the
// rapid-reconnect tacview.dll crash, custom-datasource-tacview-spec.md /
// 2026-09-06 crash log), so this is the only way back to auto-detection short
// of that. Clears the stale vote tally and re-arms the same one-shot timer
// start() uses, so the next THEATRE_VOTE_WINDOW_MS of live positions gets a
// fresh, honest vote.
function resetTheatreDetection() {
  clearTimeout(theatreTimer)
  theatreDecided = false
  theatreName = null
  theatreVotes.clear()
  theatreTimer = setTimeout(finalizeTheatre, THEATRE_VOTE_WINDOW_MS)
}

function isPolling() {
  return connected
}

function getConfig() {
  return config
}

// A bare TCP-connect success isn't discriminating enough — Olympus's HTTP
// port also accepts a TCP connection, which would make the auto-detect race
// (api.js) a coin flip on an Olympus-only deployment. Tacview's RTT server
// proactively sends its handshake greeting the instant a client connects
// (confirmed live, custom-datasource-tacview-spec.md §5 item 1); Olympus's
// HTTP server sends nothing until it receives a request. So waiting for that
// unsolicited greeting and checking its prefix is what actually tells the
// two apart.
//
// This also completes the real handshake (sending our password hash) rather
// than stopping at the greeting, so a wrong RTT password is caught here —
// surfaced to Login.jsx as a normal 502 from /api/connect — instead of
// probe() reporting success and start()'s own connect() looping forever on
// a connection the server rejects right after the handshake.
// `identified: true` on a rejection means the greeting positively confirmed
// this IS a Tacview RTT server (before we ever sent a password) — so the
// failure is specific and actionable (wrong password), not "nothing here."
// api.js's autoDetectSourceType surfaces an `identified` error over the
// generic "cannot reach any known source type" message, since we genuinely
// know which server answered and why it rejected us.
function identifiedError(message) {
  return Object.assign(new Error(message), { identified: true })
}

async function probe(cfg) {
  const { host, port } = parseHostPort(cfg.olympusUrl)
  await new Promise((resolve, reject) => {
    const probeSocket = net.createConnection({ host, port })
    let handshakeSent = false
    let settled = false

    const settle = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      probeSocket.destroy()
      fn(arg)
    }

    const timeout = setTimeout(() => {
      settle(reject, handshakeSent
        ? identifiedError('Tacview accepted the connection but sent no telemetry after the handshake — check the RTT password')
        : new Error('Tacview probe timed out — no handshake received'))
    }, 5000)

    probeSocket.on('data', (chunk) => {
      if (!handshakeSent) {
        if (!chunk.toString('utf8').startsWith('XtraLib.Stream.0')) {
          settle(reject, new Error('Connected, but response was not a Tacview RTT handshake'))
          return
        }
        handshakeSent = true
        probeSocket.write(tacviewCore.buildClientHandshake('TRACS-Probe', cfg.password))
        return
      }
      // Any data after our handshake means the server accepted it and started streaming.
      settle(resolve)
    })

    probeSocket.once('close', () => {
      if (handshakeSent) settle(reject, identifiedError('Tacview rejected the connection after the handshake — check the RTT password'))
    })

    probeSocket.once('error', (err) => {
      settle(reject, err)
    })
  })
}

module.exports = { start, stop, isPolling, getConfig, probe, overrideTheatre, resetTheatreDetection }
