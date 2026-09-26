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
// here, per-controller-backend, not inside the relay's tacview.js, because
// the relay isn't meant to bundle theatre-specific terrain data.
//
// Dispatched via the relay-as-primary branch in routes/sourceConnect.js
// (relayUrl set, no olympusUrl) — not a sourceRegistry entry.

const WebSocket = require('ws')
const { PROTOCOL_VERSION } = require('./protocolVersion')
const state = require('./state')
const navdata = require('../navdata')
const tacviewDetection = require('./tacviewDetection')
const weaponDatabase = require('./weaponDatabase')
const missileDetection = require('./missileDetection')
const rateConfig = require('./rateConfig')
const { splitByCategory, computeDateAndTime, identifiedError, createDeltaBuffer } = require('./tacviewShared')

const RECONNECT_MS = 3000
// See tacview.js's identical constant for why this was shortened from 5000.
const THEATRE_VOTE_WINDOW_MS = 2000
// See tacview.js's identical constant — re-syncs useMissionClock() against
// client-side timer drift, same as Olympus's own repeated mission poll.
const MISSION_CLOCK_INTERVAL_MS = 10000
// Detection pass, missile-detection pass, and browser-facing broadcast
// cadence all live in server/src/rateConfig.js now (rateConfig.detectionMs/
// missileDetectionMs/unitUpdateMs). Unlike direct mode, this relay-hosted
// mode's rate is owned by the relay operator (relay/index.js's config.json),
// pushed over the wire after connecting (see the 'tacviewRateConfig' message
// handler and armRateTimers() below) — never this backend's own local
// server/rateConfig.json.

let ws = null
let onUnitsDelta = null
let onWeaponsDelta = null
let onMission = null
let onBullseyes = null
let relayUrl = null
let password = null
let coalition = null
let intentionalClose = false
let reconnectTimer = null
let detectionTimer = null
let missileDetectionTimer = null
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
// Missiles get their own omniscient store, split out of internalUnits by
// category — see tacview.js's identical splitByCategory for why (they need
// entirely different visibility handling from fogFilter's unit-oriented
// exposure tracking).
let internalWeapons = {}
let fogFilter = null
let missileFogFilter = null
// Promoted out of start() — connect()'s reconnect path and the
// tacviewDetectionConfig message handler both need to read this, not just
// the initial start() call.
let friendlyCoalitionId = null

// Accumulates at full stream rate (whatever the relay forwards); flushed to
// state/broadcast at rateConfig.unitUpdateMs by unitsBuffer.flush(). Mirrors
// tacview.js's identical mechanism for direct mode — see tacviewShared.js's
// createDeltaBuffer for the merge-vs-overwrite semantics.
const unitsBuffer = createDeltaBuffer({ applyFn: state.applyDelta, merge: true })
// Mirrors unitsBuffer, for the separate weapons delta stream — a weapon and
// a unit sharing the same numeric id space would otherwise collide in one map.
const weaponsBuffer = createDeltaBuffer({ applyFn: state.applyWeaponsDelta, merge: false })
let broadcastTimer = null

function voteTheatre(positions) {
  if (theatreDecided) return
  for (const { lat, lng } of positions) {
    for (const name of navdata.theatresContaining(lat, lng)) {
      theatreVotes.set(name, (theatreVotes.get(name) ?? 0) + 1)
    }
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
  unitsBuffer.queue(updated, hidden)
}

// AWACS/EWR-only synthetic missile detection (server/src/missileDetection.js)
// — see tacview.js's identical function for the full rationale. Unlike
// fogFilter, missileFogFilter needs no relay-provided config, so it's created
// synchronously in start() rather than waiting for the relay's
// tacviewDetectionConfig handshake — no equivalent "not ready yet" gap to
// guard against here.
function runMissileDetectionPass() {
  if (!isConnected() || !missileFogFilter) return
  const { contactsUpdate, revealed, hidden } = missileFogFilter.computeVisibility(internalUnits, internalWeapons)
  if (Object.keys(contactsUpdate).length > 0) unitsBuffer.queue(contactsUpdate, [])
  if (Object.keys(revealed).length > 0 || hidden.length > 0) weaponsBuffer.queue(revealed, hidden)
}

function applyTacviewData(data) {
  const { updated = {}, removed = [], bullseyes = null, positions = [] } = data ?? {}

  if (positions.length) voteTheatre(positions)

  const { units: unitsUpdated, weapons: weaponsUpdatedRaw } = splitByCategory(updated)

  // RCS-trackability filter (shared with olympus.js's pollWeapons()/tacview.js) —
  // applied here, before ever entering internalWeapons/state.
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

  // friendlyCoalitionId === null means GM/Admin (no filter ever wanted, see
  // tacviewDetection.coalitionId) — unchanged full passthrough. A real
  // coalition with fogFilter still null means detection config hasn't
  // arrived from the relay yet (see the tacviewDetectionConfig handler in
  // connect() below) — drop rather than leak the unfiltered feed for that
  // window, unlike the GM/Admin case.
  const publicUpdated = friendlyCoalitionId === null
    ? unitsUpdated
    : fogFilter
      ? fogFilter.filterFrameUpdate(unitsUpdated)
      : {}

  if (Object.keys(publicUpdated).length || unitsRemoved.length) {
    unitsBuffer.queue(publicUpdated, unitsRemoved)
  }

  // Weapons: own-coalition/neutral pass straight through (or everything, for
  // GM/Admin); a non-friendly weapon's raw position data is only forwarded
  // once missileFogFilter has actually confirmed detection — see that
  // filter's own comment for why this redaction is necessary at all (the
  // relay's feed is just as omniscient as direct mode's).
  const publicWeaponsUpdated = friendlyCoalitionId === null
    ? weaponsUpdated
    : missileFogFilter
      ? missileFogFilter.filterFrameUpdate(weaponsUpdated)
      : {}

  if (Object.keys(publicWeaponsUpdated).length || weaponsRemoved.length) {
    weaponsBuffer.queue(publicWeaponsUpdated, weaponsRemoved)
  }

  if (bullseyes) {
    state.setBullseyes(bullseyes)
    if (onBullseyes) onBullseyes(bullseyes)
  }
}

// (Re-)creates the three rate-driven timers from rateConfig's current
// values. Called once at start() with the pre-connect defaults, and again
// whenever the relay's tacviewRateConfig message arrives — unlike a
// self-rescheduling setTimeout chain (olympus.js's pattern), setInterval's
// delay is fixed at creation time, so an already-running interval never
// picks up a config change on its own; it has to be torn down and re-armed.
function armRateTimers() {
  clearInterval(detectionTimer)
  clearInterval(missileDetectionTimer)
  clearInterval(broadcastTimer)
  detectionTimer = setInterval(runDetectionPass, rateConfig.detectionMs)
  missileDetectionTimer = setInterval(runMissileDetectionPass, rateConfig.missileDetectionMs)
  broadcastTimer = setInterval(() => { unitsBuffer.flush(onUnitsDelta); weaponsBuffer.flush(onWeaponsDelta) }, rateConfig.unitUpdateMs)
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
    socket.send(JSON.stringify({ type: 'auth', coalition, password, protocolVersion: PROTOCOL_VERSION }))
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
        if (Object.keys(catchUp).length) unitsBuffer.queue(catchUp, [])
        runDetectionPass()
      }
      return
    }
    if (msg.type === 'tacviewRateConfig') {
      // Relay-authoritative scan-rate tuning — see server/src/rateConfig.js's
      // applyRelayConfig() and relay/tacview.js's onAuthenticated(). Sent
      // unconditionally, same as tacviewDetectionConfig above, since
      // relay/index.js's config always has resolved unitUpdateMs/detectionMs/
      // missileDetectionMs values (file → env var → hardcoded default), never
      // truly "unset".
      rateConfig.applyRelayConfig(msg.config)
      console.log(`[tacviewRelayClient] relay rate config received: unitUpdateMs=${msg.config.unitUpdateMs} detectionMs=${msg.config.detectionMs} missileDetectionMs=${msg.config.missileDetectionMs}`)
      armRateTimers()
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
      console.error('[tacviewRelayClient] relay rejected our password - not retrying until reconnected with a corrected one')
      ws = null
      return
    }
    if (reason?.toString().startsWith('protocol mismatch')) {
      console.error(`[tacviewRelayClient] ${reason} - not retrying until one side is updated`)
      ws = null
      return
    }

    console.log(`[tacviewRelayClient] disconnected from relay (code ${code}${reason?.length ? `, reason: ${reason}` : ''}) - reconnecting in ${RECONNECT_MS}ms`)
    reconnectTimer = setTimeout(connect, RECONNECT_MS)
  })

  socket.on('error', (err) => {
    if (socket !== ws) return
    console.error(`[tacviewRelayClient] relay connection error: ${err.code ?? err.name ?? 'unknown'} - ${err.message || '(no message)'} - url: ${url}`)
  })
}

function start(cfg, callbacks = {}) {
  if (ws) stop()

  relayUrl = cfg.relayUrl
  password = cfg.password ?? null
  coalition = cfg.coalition ?? null
  onUnitsDelta = callbacks.onUnitsDelta ?? null
  onWeaponsDelta = callbacks.onWeaponsDelta ?? null
  onMission = callbacks.onMission ?? null
  onBullseyes = callbacks.onBullseyes ?? null
  intentionalClose = false
  theatreDecided = false
  theatreName = null
  theatreVotes.clear()
  latestMissionUtcMs = null
  state.resetForNewSource()
  internalUnits = {}
  internalWeapons = {}
  unitsBuffer.reset()
  weaponsBuffer.reset()
  friendlyCoalitionId = tacviewDetection.coalitionId(cfg.coalition)
  fogFilter = null
  // Unlike fogFilter (needs the relay's own detection config first, see the
  // tacviewDetectionConfig handler in connect() below), missileFogFilter has
  // no relay-provided config dependency — created synchronously here so
  // there's no "not ready yet" gap for weapon data to race against.
  missileFogFilter = friendlyCoalitionId !== null
    ? missileDetection.createMissileFogFilter(friendlyCoalitionId, { isOmniscient: () => !tacviewDetection.isFogOfWarEnabled() })
    : null
  // Baseline while waiting for the relay's own tacviewDetectionConfig
  // message (see the message handler in connect() above) — never the local
  // server/tacviewDetectionConfig.json file, which relay-hosted mode must
  // not consult at all (the relay operator, not the connecting controller,
  // owns this in this mode).
  tacviewDetection.resetToDefaults()
  // Same posture as tacviewDetection above — relay-hosted mode must not
  // consult this backend's own local server/rateConfig.json at all; the
  // relay operator owns the rate until its tacviewRateConfig message arrives
  // (armRateTimers() re-runs then). Warn if a local file exists anyway, since
  // it'll silently do nothing in this mode — easy to mistake for a bug.
  if (rateConfig.localConfigFileExists()) {
    console.log('[tacviewRelayClient] relay-hosted mode active - local server/rateConfig.json, if present, is ignored; rate is controlled by the relay operator\'s config.json')
  }
  rateConfig.resetToDefaults()

  connect()
  theatreTimer = setTimeout(finalizeTheatre, THEATRE_VOTE_WINDOW_MS)
  armRateTimers()
  missionClockTimer = setInterval(sendMissionClock, MISSION_CLOCK_INTERVAL_MS)
}

function stop() {
  intentionalClose = true
  clearTimeout(reconnectTimer)
  clearTimeout(theatreTimer)
  clearInterval(detectionTimer)
  clearInterval(missileDetectionTimer)
  clearInterval(broadcastTimer)
  clearInterval(missionClockTimer)
  reconnectTimer = null
  if (ws) {
    ws.close()
    ws = null
  }
  onUnitsDelta = null
  onWeaponsDelta = null
  onMission = null
  onBullseyes = null
  internalUnits = {}
  internalWeapons = {}
  fogFilter = null
  missileFogFilter = null
  friendlyCoalitionId = null
  unitsBuffer.reset()
  weaponsBuffer.reset()
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
      probeSocket.send(JSON.stringify({ type: 'auth', coalition: cfg.coalition, password: cfg.password, protocolVersion: PROTOCOL_VERSION }))
    })

    probeSocket.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString('utf8')) } catch { return }
      if (msg.type === 'auth_ok') settle(resolve)
    })

    probeSocket.on('close', (code, reason) => {
      settle(reject, reason?.toString() === 'invalid password'
        ? identifiedError('Relay rejected the connection — check the coalition password')
        : reason?.toString().startsWith('protocol mismatch')
          ? identifiedError(`Relay ${reason}`)
          : new Error('Relay closed the connection before authenticating'))
    })

    probeSocket.on('error', (err) => {
      settle(reject, err)
    })
  })
}

module.exports = { start, stop, isConnected, getConfig, probe, overrideTheatre, resetTheatreDetection }
