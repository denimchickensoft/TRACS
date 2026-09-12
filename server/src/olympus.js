'use strict'

const crypto    = require('crypto')
const state     = require('./state')
const elevation = require('./elevation')
const { decodeUnits } = require('./decoder')

const POLL_INTERVAL_MS = 1000
const MISSION_INTERVAL_MS = 10000
const AIRBASES_INTERVAL_MS = 30000
const FULL_REFRESH_EVERY = 10
const MAX_CONSECUTIVE_ERRORS = 10

let config = null
let polling = false
let pollCount = 0
let consecutiveErrors = 0
let onDisconnect = null

let unitsTimer = null
let missionTimer = null
let airbasesTimer = null

let onUnitsDelta  = null
let onMission     = null
let onAirbases    = null
let onBullseyes   = null

let lastTheatre     = null
let lastSessionHash = null

let bullseyesTimer = null

const COALITION_TO_ROLE = {
  blue:  'Blue commander',
  red:   'Red commander',
  gm:    'Game master',
  admin: 'Admin',
}

function makeAuthHeader(password, coalition) {
  const role   = COALITION_TO_ROLE[coalition] ?? ''
  const hashed = crypto.createHash('sha256').update(password).digest('hex')
  const credentials = Buffer.from(`${role}:${hashed}`).toString('base64')
  return `Basic ${credentials}`
}

async function fetchOlympusJson(path) {
  const url = `${config.olympusUrl}${path}`
  const res = await fetch(url, {
    headers: { Authorization: makeAuthHeader(config.password, config.coalition) },
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Olympus ${path} returned ${res.status}: ${text.slice(0, 200)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Olympus ${path} returned non-JSON (status ${res.status}): ${text.slice(0, 200)}`)
  }
}

async function fetchOlympusBinary(path) {
  const url = `${config.olympusUrl}${path}`
  const res = await fetch(url, {
    headers: { Authorization: makeAuthHeader(config.password, config.coalition) },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Olympus ${path} returned ${res.status}: ${text.slice(0, 200)}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

async function pollUnits() {
  if (!polling) return
  try {
    pollCount++
    const forceFullRefresh = pollCount % FULL_REFRESH_EVERY === 1
    const lastTime = forceFullRefresh ? 0 : state.getLastUpdateTime()

    const buffer = await fetchOlympusBinary(`/olympus/units?time=${lastTime}`)
    const { updateTime, units } = decodeUnits(buffer)

    const updatedMap = {}
    const removedIds = []

    for (const unit of units) {
      if (unit.alive === false) {
        // Unit is explicitly dead — remove it
        removedIds.push(String(unit.id))
      } else {
        updatedMap[String(unit.id)] = unit
      }
    }

    // On full refresh, any unit previously known but absent from the response is gone
    if (forceFullRefresh) {
      const receivedIds = new Set(units.map((u) => String(u.id)))
      for (const knownId of Object.keys(state.getSnapshot().updated)) {
        if (!receivedIds.has(knownId)) removedIds.push(knownId)
      }
    }

    // Attach AGL to airborne units only; scrub any stale value from ground/naval
    for (const [id, unit] of Object.entries(updatedMap)) {
      if (!unit.position) continue
      const category = unit.category ?? state.getUnit(id)?.category
      if (category !== 'Aircraft' && category !== 'Helicopter') { delete unit.agl; continue }
      const agl = elevation.getAgl(unit.position.lat, unit.position.lng, unit.position.alt)
      if (agl !== null) unit.agl = Math.max(0, Math.round(agl))
    }

    const delta = { updated: updatedMap, removed: removedIds, time: updateTime }
    state.applyDelta(delta)
    if (onUnitsDelta) onUnitsDelta(delta)
    consecutiveErrors = 0
  } catch (err) {
    consecutiveErrors++
    console.error(`[olympus] units poll error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, err.message)
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      console.error('[olympus] too many consecutive errors — stopping polling')
      stop()
      if (onDisconnect) onDisconnect()
      return
    }
  } finally {
    if (polling) unitsTimer = setTimeout(pollUnits, POLL_INTERVAL_MS)
  }
}

async function pollBullseyes() {
  if (!polling) return
  try {
    const data = await fetchOlympusJson('/olympus/bullseyes')
    state.setBullseyes(data)
    if (onBullseyes) onBullseyes(data)
  } catch (err) {
    console.error('[olympus] bullseyes poll error:', err.message)
  }
}

async function pollMission() {
  if (!polling) return
  try {
    const data = await fetchOlympusJson('/olympus/mission')
    state.setMission(data)
    if (onMission) onMission(data)

    // Re-poll bullseyes whenever the session hash changes (mission reload)
    const newHash = data?.sessionHash ?? null
    if (newHash && newHash !== lastSessionHash) {
      lastSessionHash = newHash
      clearTimeout(bullseyesTimer)
      pollBullseyes()
    }

    const theatre = data?.mission?.theatre ?? data?.theatre ?? null
    if (theatre && theatre !== lastTheatre) {
      lastTheatre = theatre
      clearTimeout(airbasesTimer)
      pollAirbases()
      clearTimeout(bullseyesTimer)
      pollBullseyes()
    }
  } catch (err) {
    console.error('[olympus] mission poll error:', err.message)
  } finally {
    if (polling) missionTimer = setTimeout(pollMission, MISSION_INTERVAL_MS)
  }
}

async function pollAirbases() {
  if (!polling) return
  try {
    const data = await fetchOlympusJson('/olympus/airbases')
    state.setAirbases(data)
    if (onAirbases) onAirbases(data)
  } catch (err) {
    console.error('[olympus] airbases poll error:', err.message)
  } finally {
    if (polling) airbasesTimer = setTimeout(pollAirbases, AIRBASES_INTERVAL_MS)
  }
}

function start(cfg, callbacks = {}) {
  if (polling) stop()

  config = cfg
  onUnitsDelta    = callbacks.onUnitsDelta    ?? null
  onMission       = callbacks.onMission       ?? null
  onAirbases      = callbacks.onAirbases      ?? null
  onBullseyes     = callbacks.onBullseyes     ?? null
  onDisconnect    = callbacks.onDisconnect    ?? null

  polling = true
  pollCount = 0
  consecutiveErrors = 0
  lastTheatre = null
  lastSessionHash = null
  state.resetForNewSource()

  console.log(`[olympus] starting polling → ${config.olympusUrl}`)
  pollUnits()
  pollMission()
  pollAirbases()
  pollBullseyes()
}

function stop() {
  polling = false
  clearTimeout(unitsTimer)
  clearTimeout(missionTimer)
  clearTimeout(airbasesTimer)
  clearTimeout(bullseyesTimer)
  config = null
  console.log('[olympus] polling stopped')
}

function isPolling() {
  return polling
}

function getConfig() {
  return config
}

async function probe(cfg) {
  const url = `${cfg.olympusUrl}/olympus/mission`
  const authHeader = makeAuthHeader(cfg.password ?? '', cfg.coalition ?? '')
  const res = await fetch(url, {
    headers: { Authorization: authHeader },
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`Olympus responded ${res.status}`)
}

module.exports = { start, stop, isPolling, getConfig, probe }
