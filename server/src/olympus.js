'use strict'

const crypto = require('crypto')
const state = require('./state')
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

let onUnitsDelta = null
let onMission = null
let onAirbases = null

function makeAuthHeader(password) {
  const hashed = crypto.createHash('sha256').update(password).digest('hex')
  const credentials = Buffer.from(`:${hashed}`).toString('base64')
  return `Basic ${credentials}`
}

async function fetchOlympusJson(path) {
  const url = `${config.olympusUrl}${path}`
  const res = await fetch(url, {
    headers: { Authorization: makeAuthHeader(config.password) },
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
    headers: { Authorization: makeAuthHeader(config.password) },
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

async function pollMission() {
  if (!polling) return
  try {
    const data = await fetchOlympusJson('/olympus/mission')
    state.setMission(data)
    if (onMission) onMission(data)
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
  onDisconnect    = callbacks.onDisconnect    ?? null

  polling = true
  pollCount = 0
  consecutiveErrors = 0
  state.clearUnits()

  console.log(`[olympus] starting polling → ${config.olympusUrl}`)
  pollUnits()
  pollMission()
  pollAirbases()
}

function stop() {
  polling = false
  clearTimeout(unitsTimer)
  clearTimeout(missionTimer)
  clearTimeout(airbasesTimer)
  config = null
  console.log('[olympus] polling stopped')
}

function isPolling() {
  return polling
}

async function probe(cfg) {
  const url = `${cfg.olympusUrl}/olympus/mission`
  const hashed = crypto.createHash('sha256').update(cfg.password ?? '').digest('hex')
  const authHeader = `Basic ${Buffer.from(`:${hashed}`).toString('base64')}`
  const res = await fetch(url, {
    headers: { Authorization: authHeader },
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`Olympus responded ${res.status}`)
}

module.exports = { start, stop, isPolling, probe }
