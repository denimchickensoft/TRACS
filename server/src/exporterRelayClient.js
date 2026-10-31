'use strict'

// Relay-hosted DCS exporter client — connects OUT to a TRACS relay's /data
// capability, which serves what TRACS's own DCS hook
// (relay/dcs/Scripts/Hooks/TRACS-Exporter.lua) collects. The primary source
// of truth for units when the relay's /health says primary: 'exporter';
// dispatched from routes/sourceConnect.js's Relay branch instead of
// tacviewRelayClient.js, never alongside it.
//
// Data arrives as named groups (units, bullseyes, clock, airbases, contacts,
// weather; more as the hook gains collectors), each a full snapshot or a delta
// where null means removed. GROUP_HANDLERS maps a group to what it does here,
// so a new collector only needs a handler.
//
// Fog of war: the feed has every unit, like Tacview's. A coalition controller
// gets tacviewDetection.js's modelled detection, tuned by the relay
// operator's detection config, until the hook sends real DCS contacts.

const WebSocket = require('ws')
const { PROTOCOL_VERSION } = require('./protocolVersion')
const state = require('./state')
const elevation = require('./elevation')
const tacviewDetection = require('./tacviewDetection')
const exporterContacts = require('./exporterContacts')
const exporterWeather = require('./exporterWeather')
const rateConfig = require('./rateConfig')
const { identifiedError, createDeltaBuffer } = require('./tacviewShared')

const RECONNECT_MIN_MS = 3000
const RECONNECT_MAX_MS = 60000
let reconnectDelayMs = RECONNECT_MIN_MS

// DCS Group.Category values the hook reports; anything else (trains) isn't
// a tracked unit.
const CATEGORY_NAMES = ['Aircraft', 'Helicopter', 'GroundUnit', 'NavyUnit']
const RAD_TO_DEG = 180 / Math.PI

// One exporter unit record -> the unit shape the rest of TRACS uses, field
// for field as Olympus sends it (name is the type, callsign the unit's
// mission name, unitName the player if there is one). heading is the same
// raw engine heading Olympus sends, normalised to 0..2π; pitch is degrees,
// as tacviewDetection.js's scan-volume check expects. Returns null for a
// record that isn't a tracked unit.
function toTracsUnit(id, rec) {
  const category = CATEGORY_NAMES[rec?.category]
  if (!category) return null
  const unitID = Number(id)
  const vx = rec.vx ?? 0
  const vy = rec.vy ?? 0
  const vz = rec.vz ?? 0
  let heading = rec.heading
  if (typeof heading === 'number' && heading < 0) heading += 2 * Math.PI
  const unit = {
    id: unitID,
    unitID,
    name: rec.type,
    unitName: rec.player ?? rec.name,
    callsign: rec.name,
    category,
    coalition: rec.coalition,
    groupID: rec.groupId,
    groupName: rec.groupName,
    position: { lat: rec.lat, lng: rec.lon, alt: rec.alt },
    agl: rec.agl,
    heading,
    speed: Math.hypot(vx, vy, vz),
    horizontalVelocity: Math.hypot(vx, vz),
    verticalVelocity: vy,
    airborne: rec.inAir === true,
    // A client-side hook's records carry no life (the export API has none).
    alive: rec.life === undefined || rec.life >= 1,
    human: rec.player != null || rec.human === true,
  }
  if (typeof rec.pitch === 'number') unit.pitch = rec.pitch * RAD_TO_DEG
  if (rec.life0 > 0) unit.health = Math.round(Math.min(100, Math.max(0, (rec.life ?? 0) / rec.life0 * 100)))
  return unit
}

// The hook's clock record -> mission.dateAndTime as Olympus sends it: date
// and time both theatre-local. absTime counts seconds from midnight of the
// mission's start date, so whole days past it move the date forward (Olympus
// keeps the start date). Returns null for an unusable record.
function toDateAndTime(rec) {
  const d = rec?.date
  const abs = rec?.absTime
  if (!d || ![d.Year, d.Month, d.Day].every(Number.isInteger) || typeof abs !== 'number' || !(abs >= 0)) return null
  const t = new Date(Date.UTC(d.Year, d.Month - 1, d.Day) + Math.floor(abs) * 1000)
  return {
    date: { Day: t.getUTCDate(), Month: t.getUTCMonth() + 1, Year: t.getUTCFullYear() },
    time: { h: t.getUTCHours(), m: t.getUTCMinutes(), s: t.getUTCSeconds() },
    startTime: rec.startTime,
  }
}

let ws = null
let active = false
let linkIssue = null
let onLinkIssue = null
let onUnitsDelta = null
let onMission = null
let onBullseyes = null
let onAirbases = null
let onWeather = null
let relayUrl = null
let password = null
let coalition = null
let intentionalClose = false
let reconnectTimer = null
let detectionTimer = null
let broadcastTimer = null
let theatreName = null
let dateAndTime = null
// The mission's weather table, its cloud preset's layers, live fog and live
// per-airfield weather, published together as
// { mission, cloudPreset, fog, airfields }.
let missionWeather = null
let cloudPreset = null
let fog = null
let airfieldsWeather = {}

// Omniscient truth (all coalitions), keyed by unit id; only fogFilter's
// output reaches state. Same split as tacviewRelayClient.js.
let internalUnits = {}
let fogFilter = null
// GM/Admin only (friendlyCoalitionId null): contacts for every side, see
// tacviewDetection.js's createAllSidesDetector.
let allSidesDetector = null
let friendlyCoalitionId = null
// Real DCS contacts (a server-side hook's contacts group), see
// exporterContacts.js. Until the first one arrives, contacts and exposure
// come from the modelled detection above; after it, from these alone.
let contactMasks = null
let realFilter = null
let realAllSides = null
// Units whose modelled contacts the next pass clears after the switch.
let staleContactIds = []

const unitsBuffer = createDeltaBuffer({
  applyFn: (d) => { elevation.enrichTerrainAhead(d.updated, state.getUnit); state.applyDelta(d) },
  merge: true,
})

// Queues a units change for state/broadcast, through the fog filter for a
// coalition controller. GM/Admin (friendlyCoalitionId null) see everything;
// a coalition controller sees nothing new until the relay's config has
// created the filter, rather than the unfiltered feed.
function queueUnits(updated, removed) {
  const filter = realFilter ?? fogFilter
  const publicUpdated = friendlyCoalitionId === null
    ? updated
    : filter ? filter.filterFrameUpdate(updated) : {}
  for (const id of removed) filter?.forget(id)
  if (Object.keys(publicUpdated).length || removed.length) unitsBuffer.queue(publicUpdated, removed)
}

// Applies one units group message. A full snapshot replaces every unit, so
// anything missing from it is removed.
function applyUnits(kind, data) {
  const updated = {}
  const removed = []
  const entries = data && typeof data === 'object' ? Object.entries(data) : []
  if (kind === 'full') {
    const keep = new Set()
    for (const [id, rec] of entries) {
      const unit = toTracsUnit(id, rec)
      if (unit) { updated[id] = unit; keep.add(id) }
    }
    for (const id of Object.keys(internalUnits)) if (!keep.has(id)) removed.push(id)
    internalUnits = { ...updated }
  } else {
    for (const [id, rec] of entries) {
      const unit = rec === null ? null : toTracsUnit(id, rec)
      if (unit) {
        updated[id] = unit
        internalUnits[id] = unit
      } else if (internalUnits[id] !== undefined) {
        delete internalUnits[id]
        removed.push(id)
      }
    }
  }
  queueUnits(updated, removed)
}

// Bullseyes keyed by coalition id, in the shape Olympus sends:
// { bullseyes: { '2': { coalition: 'blue', latitude, longitude }, ... } }.
function applyBullseyes(kind, data) {
  if (!data || typeof data !== 'object') return
  const bullseyes = { bullseyes: data }
  state.setBullseyes(bullseyes)
  if (onBullseyes) onBullseyes(bullseyes)
}

function publishMission() {
  const mission = { mission: { theatre: theatreName ?? undefined, dateAndTime: dateAndTime ?? undefined } }
  state.setMission(mission)
  if (onMission) onMission(mission)
}

function applyClock(kind, data) {
  const next = toDateAndTime(data)
  if (!next) return
  dateAndTime = next
  publishMission()
}

// Airbases (airfields, FARPs, carriers) in the shape Olympus sends:
// { airbases: { '1': { callsign, coalition, latitude, longitude, unitId? } } }.
function applyAirbases(kind, data) {
  if (!data || typeof data !== 'object') return
  publishAirbases({ airbases: data })
}

function publishAirbases(airbases) {
  state.setAirbases(airbases)
  if (onAirbases) onAirbases(airbases)
}

function resetWeather() {
  missionWeather = null
  cloudPreset = null
  fog = null
  airfieldsWeather = {}
}

function publishWeather() {
  const weather = { mission: missionWeather, cloudPreset, fog, airfields: airfieldsWeather }
  state.setWeather(weather)
  if (onWeather) onWeather(weather)
}

function applyWeather(kind, data) {
  missionWeather = data?.mission && typeof data.mission === 'object' ? data.mission : null
  cloudPreset = data?.cloudPreset && typeof data.cloudPreset === 'object' ? data.cloudPreset : null
  publishWeather()
}

function applyFog(kind, data) {
  fog = data && typeof data === 'object' ? data : null
  publishWeather()
}

function applyAirfieldWeather(kind, data) {
  airfieldsWeather = exporterWeather.toAirfieldsWeather(data)
  publishWeather()
}

// The first contacts message switches from modelled to real contacts: the
// modelled lists are cleared, and every enemy the model had exposed is hidden
// unless the real contacts show it.
function switchToRealContacts() {
  staleContactIds = Object.keys(internalUnits).filter((id) => {
    const c = internalUnits[id].coalition
    return friendlyCoalitionId === null ? c === 1 || c === 2 : c === friendlyCoalitionId
  })
  if (friendlyCoalitionId === null) {
    realAllSides = exporterContacts.createRealAllSidesDetector()
  } else {
    const enemies = Object.keys(internalUnits).filter((id) => internalUnits[id].coalition !== friendlyCoalitionId)
    realFilter = exporterContacts.createRealContactsFilter(friendlyCoalitionId, enemies)
  }
}

function applyContacts(kind, data) {
  const first = contactMasks === null
  contactMasks = exporterContacts.applyContactsMessage(contactMasks, kind, data)
  if (first) switchToRealContacts()
  runDetectionPass()
}

// A client-side hook's exportStatus: whether the DCS server allows object
// export. Without it a client hook has no units to send, which the status bar
// should explain.
function applyExportStatus(kind, data) {
  if (data?.objects === false) {
    if (linkIssue?.reason !== 'exporter_object_export_denied') setLinkIssue({ retrying: false, reason: 'exporter_object_export_denied' })
  } else if (linkIssue?.reason === 'exporter_object_export_denied') {
    setLinkIssue(null)
  }
}

const GROUP_HANDLERS = {
  units: applyUnits,
  bullseyes: applyBullseyes,
  clock: applyClock,
  airbases: applyAirbases,
  contacts: applyContacts,
  exportStatus: applyExportStatus,
  weather: applyWeather,
  fog: applyFog,
  airfieldWeather: applyAirfieldWeather,
}

function applyGroup(group, kind, data) {
  const handler = GROUP_HANDLERS[group]
  if (handler) handler(kind, data)
}

// The hook's hello carries the mission's theatre (DCS's own name for it, as
// Olympus reports it), so there's no position voting as with Tacview.
function applyHook(hook) {
  const theatre = hook?.theatre
  if (!theatre || theatre === theatreName) return
  theatreName = theatre
  publishMission()
}

// The hook went away (DCS closed, or the mission is changing): everything
// it sent is stale, the clock included.
function clearUnits() {
  if (linkIssue?.reason === 'exporter_object_export_denied') setLinkIssue(null)
  const removed = Object.keys(internalUnits)
  internalUnits = {}
  if (dateAndTime) {
    dateAndTime = null
    publishMission()
  }
  if (Object.keys(state.getAirbases()?.airbases ?? {}).length) publishAirbases({ airbases: {} })
  if (missionWeather || fog || Object.keys(airfieldsWeather).length) {
    resetWeather()
    publishWeather()
  }
  if (fogFilter) fogFilter = tacviewDetection.createFogFilter(friendlyCoalitionId)
  if (allSidesDetector) allSidesDetector = tacviewDetection.createAllSidesDetector()
  resetRealContacts()
  if (removed.length) unitsBuffer.queue({}, removed)
}

// The next hook may be a client-side one, which sends no contacts.
function resetRealContacts() {
  contactMasks = null
  realFilter = null
  realAllSides = null
  staleContactIds = []
}

function runRealContactsPass() {
  const cleared = {}
  for (const id of staleContactIds) if (internalUnits[id]) cleared[id] = { contacts: [] }
  staleContactIds = []
  if (realAllSides) {
    const contactsUpdate = { ...cleared, ...realAllSides.computeContacts(internalUnits, contactMasks) }
    if (Object.keys(contactsUpdate).length) unitsBuffer.queue(contactsUpdate, [])
    return
  }
  if (!realFilter) return
  const { contactsUpdate, revealed, hidden } = realFilter.computeVisibility(internalUnits, contactMasks)
  const updated = { ...cleared, ...contactsUpdate, ...revealed }
  if (Object.keys(updated).length === 0 && hidden.length === 0) return
  unitsBuffer.queue(updated, hidden)
}

function runDetectionPass() {
  if (!isConnected()) return
  if (contactMasks) {
    runRealContactsPass()
    return
  }
  if (allSidesDetector) {
    const contactsUpdate = allSidesDetector.computeContacts(internalUnits)
    if (Object.keys(contactsUpdate).length) unitsBuffer.queue(contactsUpdate, [])
    return
  }
  if (!fogFilter) return
  const { contactsUpdate, revealed, hidden } = fogFilter.computeVisibility(internalUnits)
  const updated = { ...contactsUpdate, ...revealed }
  if (Object.keys(updated).length === 0 && hidden.length === 0) return
  unitsBuffer.queue(updated, hidden)
}

// setInterval's delay is fixed at creation, so a rate change from the relay
// means tearing the timers down and re-arming them.
function armRateTimers() {
  clearInterval(detectionTimer)
  clearInterval(broadcastTimer)
  detectionTimer = setInterval(runDetectionPass, rateConfig.detectionMs)
  broadcastTimer = setInterval(() => unitsBuffer.flush(onUnitsDelta), rateConfig.unitUpdateMs)
}

// See server/src/linkStatus.js for the shape.
function setLinkIssue(issue) {
  linkIssue = issue
  if (onLinkIssue) onLinkIssue(issue)
}

// The link issue the hook's presence implies, given the current one;
// undefined leaves it as it is. No hook connected to the relay means DCS
// isn't running the exporter (or is between missions): retrying, not failed.
// A hook whose DLL failed to load or failed its self-test sends nothing until
// the next mission, with the reason in its hello.
function hookPresenceIssue(hook, current) {
  if (hook?.dll && hook.dll.ok === false) {
    const detail = String(hook.dll.error ?? 'unknown error')
    if (current?.reason === 'exporter_dll_failed' && current.detail === detail) return undefined
    return { retrying: false, reason: 'exporter_dll_failed', detail }
  }
  if (hook) {
    return current?.reason === 'exporter_no_hook' || current?.reason === 'exporter_dll_failed' ? null : undefined
  }
  if (!current || current.reason === 'exporter_dll_failed') return { retrying: true, reason: 'exporter_no_hook' }
  return undefined
}

function applyHookPresence(hook) {
  const next = hookPresenceIssue(hook, linkIssue)
  if (next !== undefined) setLinkIssue(next)
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'exporterConfig':
      // The relay operator's tuning, sent before the snapshot on every
      // authenticated connection.
      tacviewDetection.applyRelayConfig(msg.detection ?? {})
      rateConfig.applyRelayConfig(msg.rates ?? {})
      armRateTimers()
      if (friendlyCoalitionId !== null && !fogFilter) fogFilter = tacviewDetection.createFogFilter(friendlyCoalitionId)
      break
    case 'exporterSnapshot':
      applyHookPresence(msg.hook)
      applyHook(msg.hook)
      for (const [group, entry] of Object.entries(msg.groups ?? {})) applyGroup(group, 'full', entry?.data)
      runDetectionPass()
      break
    case 'exporterHello':
      applyHookPresence(msg.hook)
      applyHook(msg.hook)
      break
    case 'exporterData':
      applyGroup(msg.group, msg.kind, msg.data)
      break
    case 'exporterReset':
      clearUnits()
      applyHookPresence(null)
      break
  }
}

function connect() {
  const url = `${relayUrl.replace(/\/+$/, '')}/data`
  // Handlers close over this socket and ignore events once it's been
  // superseded, same as tacviewRelayClient.js.
  const socket = new WebSocket(url)
  ws = socket

  socket.on('open', () => {
    if (socket !== ws) { socket.close(); return }
    console.log(`[exporterRelayClient] connected to relay at ${url}`)
    socket.send(JSON.stringify({ type: 'auth', coalition, password, protocolVersion: PROTOCOL_VERSION }))
  })

  socket.on('message', (raw) => {
    if (socket !== ws) return
    reconnectDelayMs = RECONNECT_MIN_MS
    if (linkIssue?.reason === 'relay_no_response') setLinkIssue(null)
    let msg
    try {
      msg = JSON.parse(raw.toString('utf8'))
    } catch (err) {
      console.error('[exporterRelayClient] failed to parse relay message:', err.message)
      return
    }
    handleMessage(msg)
  })

  socket.on('close', (code, reason) => {
    if (socket !== ws) return
    if (intentionalClose) return
    const text = reason?.toString() ?? ''

    if (text === 'invalid password') {
      console.error('[exporterRelayClient] relay rejected our password - not retrying until reconnected with a corrected one')
      ws = null
      clearTimers()
      setLinkIssue({ retrying: false, reason: 'relay_invalid_password' })
      return
    }
    if (text.startsWith('protocol mismatch')) {
      console.error(`[exporterRelayClient] ${text} - not retrying until one side is updated`)
      ws = null
      clearTimers()
      setLinkIssue({ retrying: false, reason: 'relay_protocol_mismatch' })
      return
    }

    setLinkIssue({ retrying: true, reason: 'relay_no_response' })
    const delay = reconnectDelayMs
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS)
    console.log(`[exporterRelayClient] disconnected from relay (code ${code}${text ? `, reason: ${text}` : ''}) - reconnecting in ${Math.round(delay / 1000)}s`)
    reconnectTimer = setTimeout(connect, delay)
  })

  socket.on('error', (err) => {
    if (socket !== ws) return
    console.error(`[exporterRelayClient] relay connection error: ${err.code ?? err.name ?? 'unknown'} - ${err.message || '(no message)'} - url: ${url}`)
  })
}

function start(cfg, callbacks = {}) {
  if (ws) stop()
  reconnectDelayMs = RECONNECT_MIN_MS
  relayUrl = cfg.relayUrl
  password = cfg.password ?? null
  coalition = cfg.coalition ?? null
  onUnitsDelta = callbacks.onUnitsDelta ?? null
  onMission = callbacks.onMission ?? null
  onBullseyes = callbacks.onBullseyes ?? null
  onAirbases = callbacks.onAirbases ?? null
  onWeather = callbacks.onWeather ?? null
  onLinkIssue = callbacks.onLinkIssue ?? null
  linkIssue = null
  active = true
  intentionalClose = false
  theatreName = null
  dateAndTime = null
  resetWeather()
  state.resetForNewSource()
  internalUnits = {}
  unitsBuffer.reset()
  friendlyCoalitionId = tacviewDetection.coalitionId(cfg.coalition)
  fogFilter = null
  allSidesDetector = friendlyCoalitionId === null ? tacviewDetection.createAllSidesDetector() : null
  resetRealContacts()
  // The relay operator owns detection and rate tuning in this mode, as with
  // relay-hosted Tacview; defaults until the relay's exporterConfig arrives.
  tacviewDetection.resetToDefaults()
  rateConfig.resetToDefaults()
  connect()
  armRateTimers()
}

function clearTimers() {
  clearTimeout(reconnectTimer)
  clearInterval(detectionTimer)
  clearInterval(broadcastTimer)
  reconnectTimer = null
}

function stop() {
  intentionalClose = true
  active = false
  linkIssue = null
  onLinkIssue = null
  clearTimers()
  if (ws) {
    ws.close()
    ws = null
  }
  onUnitsDelta = null
  onMission = null
  onBullseyes = null
  onAirbases = null
  onWeather = null
  internalUnits = {}
  fogFilter = null
  allSidesDetector = null
  resetRealContacts()
  friendlyCoalitionId = null
  theatreName = null
  dateAndTime = null
  resetWeather()
  unitsBuffer.reset()
  if (relayUrl) console.log('[exporterRelayClient] stopped')
}

function isConnected() {
  return ws !== null && ws.readyState === WebSocket.OPEN
}

// Started and not stopped, whether or not the relay is reachable right now.
function isActive() {
  return active
}

function getLinkIssue() {
  return linkIssue
}

function getConfig() {
  return relayUrl ? { relayUrl, password, coalition } : null
}

// Throwaway connection that checks the relay is reachable and accepts this
// coalition/password before committing to a live one, as
// tacviewRelayClient.js's probe() does for /tacview.
async function probe(cfg) {
  const url = `${cfg.relayUrl.replace(/\/+$/, '')}/data`
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
    const timeout = setTimeout(() => settle(reject, new Error('Relay probe timed out — no response')), 5000)

    probeSocket.on('open', () => {
      probeSocket.send(JSON.stringify({ type: 'auth', coalition: cfg.coalition, password: cfg.password, protocolVersion: PROTOCOL_VERSION }))
    })
    probeSocket.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString('utf8')) } catch { return }
      if (msg.type === 'auth_ok') settle(resolve)
    })
    probeSocket.on('close', (code, reason) => {
      const text = reason?.toString() ?? ''
      settle(reject, text === 'invalid password'
        ? identifiedError('Relay rejected the connection — check the coalition password')
        : text.startsWith('too many failed attempts')
          ? identifiedError('Relay is refusing this computer after too many wrong passwords — try again in a few minutes')
          : text.startsWith('protocol mismatch')
            ? identifiedError(`Relay ${text}`)
            : text === 'exporter disabled on this relay'
              ? identifiedError('Relay doesn’t have the DCS exporter enabled')
              : new Error('Relay closed the connection before authenticating'))
    })
    probeSocket.on('error', (err) => settle(reject, err))
  })
}

module.exports = { start, stop, isConnected, isActive, getLinkIssue, getConfig, probe, toTracsUnit, toDateAndTime, hookPresenceIssue }
