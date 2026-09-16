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
const weaponDatabase = require('./weaponDatabase')
const missileDetection = require('./missileDetection')
const rateConfig = require('./rateConfig')
const { splitByCategory, computeDateAndTime, identifiedError, createDeltaBuffer } = require('./tacviewShared')

const DEFAULT_PORT = 42674
const RECONNECT_MS = 3000
// Was 5000 — never a measured minimum, just an untested comfortable margin
// (see custom-datasource-tacview-spec.md §4.2). Shortened 2026-09-06 to cut
// Login's facility-picker wait; the manual theatre override remains the real
// safety net against a border-overlap-zone misvote, not this window's length.
const THEATRE_VOTE_WINDOW_MS = 2000
// Detection pass, missile-detection pass, and browser-facing broadcast
// cadence all live in server/src/rateConfig.js now (rateConfig.detectionMs/
// missileDetectionMs/unitUpdateMs) — operator-tunable via
// server/rateConfig.json, so an installation can match a real radar's scan
// rate instead of this project's original 1Hz testing-fidelity default.
// Incoming ACMI updates are still parsed/tracked at full stream rate
// internally (needed for the groundspeed derivation's accuracy) regardless
// of rateConfig.unitUpdateMs — only the browser-facing broadcast is
// throttled.
// Re-sync the mission clock this often (matches olympus.js's own
// MISSION_INTERVAL_MS) — useMissionClock() free-runs client-side off of
// whatever dateAndTime it was last given, so periodic re-sends correct any
// client-side timer drift over a long session, same as Olympus already does.
const MISSION_CLOCK_INTERVAL_MS = 10000
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
let missileDetectionTimer = null
let theatreTimer = null
let missionClockTimer = null
let theatreDecided = false
let theatreName = null
const theatreVotes = new Map()

// Omniscient truth (all coalitions) — deliberately never exposed via `state`
// directly. `state`/broadcast only ever receive the fog-filtered subset; see
// tacviewDetection.js's createFogFilter for why this split exists.
let internalUnits = {}
// Missiles get their own omniscient store, split out of internalUnits by
// category (see splitByCategory below) — they need entirely different
// visibility handling (own-coalition always visible + missileDetection.js's
// AWACS/EWR gating, not fogFilter's exposure-tracking), so keeping them
// mixed into internalUnits would make that split harder to reason about, not
// easier.
let internalWeapons = {}
let fogFilter = null
let missileFogFilter = null
// Promoted to module scope (not just a local inside start()) so
// runMissileDetectionPass() can read it — mirrors tacviewRelayClient.js's
// identical promotion of the same value.
let friendlyCoalitionId = null

let onUnitsDelta = null
let onWeaponsDelta = null
let onMission = null
let onBullseyes = null
let onDisconnect = null
let handshakeFailures = 0

// Accumulates at full stream rate; flushed to state/broadcast once per
// rateConfig.unitUpdateMs by unitsBuffer.flush(). Both processIncoming and
// runDetectionPass write here instead of calling state.applyDelta directly.
// merge:true — see tacviewShared.js's createDeltaBuffer for why (processIncoming's
// full unit vs. runDetectionPass's partial {contacts:[...]} race).
const unitsBuffer = createDeltaBuffer({ applyFn: state.applyDelta, merge: true })
// Mirrors unitsBuffer, for the separate weapons delta stream (own state.js
// store, own onWeaponsDelta callback, own message type) — not reusing the
// units buffer since a weapon and a unit sharing the same numeric id space
// would otherwise collide in one map. merge:false — no equivalent partial-
// write race for weapons.
const weaponsBuffer = createDeltaBuffer({ applyFn: state.applyWeaponsDelta, merge: false })
let broadcastTimer = null

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
  unitsBuffer.queue(updated, hidden)
}

// AWACS/EWR-only synthetic missile detection (server/src/missileDetection.js)
// — neither real Olympus weapon objects nor Tacview's have any native
// detection data, so this runs on its own cadence against the current
// internalUnits/internalWeapons, same design as olympus.js's
// pollMissileDetection(). No-op for a gm/admin session (missileFogFilter
// null), matching fogFilter's identical godmode exemption. Also drives the
// weapon fog-of-war reveal/hide cycle (missileFogFilter.computeVisibility),
// not just the units-side missileContacts[] update — see
// missileDetection.js's createMissileFogFilter for why weapons need this at
// all (Olympus's own /olympus/weapons endpoint sends unredacted omniscient
// data, confirmed live 2026-09-15).
function runMissileDetectionPass() {
  if (!connected || !missileFogFilter) return
  const { contactsUpdate, revealed, hidden } = missileFogFilter.computeVisibility(internalUnits, internalWeapons)
  if (Object.keys(contactsUpdate).length > 0) unitsBuffer.queue(contactsUpdate, [])
  if (Object.keys(revealed).length > 0 || hidden.length > 0) weaponsBuffer.queue(revealed, hidden)
}

let lineBuffer = ''
function processIncoming(text) {
  lineBuffer += text
  const lines = lineBuffer.split('\n')
  lineBuffer = lines.pop() ?? ''
  if (lines.length === 0) return

  const { updated, removed, bullseyes, positions } = parser.parseLines(lines)

  if (positions.length) voteTheatre(positions)

  const { units: unitsUpdated, weapons: weaponsUpdatedRaw } = splitByCategory(updated)

  // RCS-trackability filter (shared with olympus.js's pollWeapons()) — applied
  // here, before ever entering internalWeapons/state, not deferred to render
  // time.
  const weaponsUpdated = {}
  for (const [id, weapon] of Object.entries(weaponsUpdatedRaw)) {
    if (weaponDatabase.isTrackableMissile(weapon.name)) weaponsUpdated[id] = weapon
  }

  Object.assign(internalUnits, unitsUpdated)
  Object.assign(internalWeapons, weaponsUpdated)

  const unitsRemoved = []
  const weaponsRemoved = []
  for (const id of removed) {
    if (internalWeapons[id] !== undefined) {
      delete internalWeapons[id]
      if (missileFogFilter) missileFogFilter.forget(id)
      weaponsRemoved.push(id)
    } else {
      delete internalUnits[id]
      if (fogFilter) fogFilter.forget(id)
      unitsRemoved.push(id)
    }
  }

  const publicUpdated = fogFilter ? fogFilter.filterFrameUpdate(unitsUpdated) : unitsUpdated
  if (Object.keys(publicUpdated).length || unitsRemoved.length) {
    unitsBuffer.queue(publicUpdated, unitsRemoved)
  }

  // Weapons: own-coalition/neutral pass straight through; a non-friendly
  // weapon's raw position data is only forwarded once missileFogFilter has
  // actually confirmed it detected (see that filter's own comment for why
  // this redaction is necessary on Tacview, same as fogFilter is for units).
  const publicWeaponsUpdated = missileFogFilter ? missileFogFilter.filterFrameUpdate(weaponsUpdated) : weaponsUpdated
  if (Object.keys(publicWeaponsUpdated).length || weaponsRemoved.length) {
    weaponsBuffer.queue(publicWeaponsUpdated, weaponsRemoved)
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
  onWeaponsDelta = callbacks.onWeaponsDelta ?? null
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
  internalWeapons = {}
  handshakeFailures = 0
  unitsBuffer.reset()
  weaponsBuffer.reset()
  // Guards against a prior relay-hosted session (tacviewRelayClient.js)
  // having left tacviewDetection's shared config sourced from a relay —
  // direct mode always forces itself back to the local file/defaults.
  tacviewDetection.resetToLocalConfig()
  // Direct mode always uses this backend's own local server/rateConfig.json
  // (or built-in defaults) — never a relay's, same posture as detection
  // config above. Must run before the setInterval calls below so they pick
  // up the resolved values.
  rateConfig.resetToLocalConfig()
  friendlyCoalitionId = tacviewDetection.coalitionId(cfg.coalition)
  fogFilter = friendlyCoalitionId !== null ? tacviewDetection.createFogFilter(friendlyCoalitionId) : null
  missileFogFilter = friendlyCoalitionId !== null ? missileDetection.createMissileFogFilter(friendlyCoalitionId) : null

  connect()
  theatreTimer = setTimeout(finalizeTheatre, THEATRE_VOTE_WINDOW_MS)
  detectionTimer = setInterval(runDetectionPass, rateConfig.detectionMs)
  missileDetectionTimer = setInterval(runMissileDetectionPass, rateConfig.missileDetectionMs)
  broadcastTimer = setInterval(() => { unitsBuffer.flush(onUnitsDelta); weaponsBuffer.flush(onWeaponsDelta) }, rateConfig.unitUpdateMs)
  missionClockTimer = setInterval(sendMissionClock, MISSION_CLOCK_INTERVAL_MS)
}

function stop() {
  intentionalClose = true
  connected = false
  clearTimeout(reconnectTimer)
  clearTimeout(theatreTimer)
  clearInterval(missionClockTimer)
  clearInterval(detectionTimer)
  clearInterval(missileDetectionTimer)
  clearInterval(broadcastTimer)
  reconnectTimer = null
  if (socket) {
    socket.destroy()
    socket = null
  }
  config = null
  internalUnits = {}
  internalWeapons = {}
  fogFilter = null
  missileFogFilter = null
  friendlyCoalitionId = null
  unitsBuffer.reset()
  weaponsBuffer.reset()
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
// `identified: true` (tacviewShared.js's identifiedError) on a rejection
// means the greeting positively confirmed this IS a Tacview RTT server
// (before we ever sent a password) — so the failure is specific and
// actionable (wrong password), not "nothing here." api.js's
// autoDetectSourceType surfaces an `identified` error over the generic
// "cannot reach any known source type" message, since we genuinely know
// which server answered and why it rejected us.
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
