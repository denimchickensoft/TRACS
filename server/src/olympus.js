'use strict'

const crypto    = require('crypto')
const state     = require('./state')
const elevation = require('./elevation')
const { decodeUnits } = require('./decoder')
const weaponDatabase = require('./weaponDatabase')
const missileDetection = require('./missileDetection')
const { coalitionId } = require('./tacviewDetection')
const rateConfig = require('./rateConfig')
const { identifiedError } = require('./tacviewShared')

const MISSION_INTERVAL_MS = 10000
const AIRBASES_INTERVAL_MS = 30000
const FULL_REFRESH_EVERY = 10
// After this many consecutive failed unit polls Olympus is treated as
// unreachable: clients are told (onDisconnect), the other pollers pause, and
// unit polls drop to one attempt every SLOW_RETRY_MS until one succeeds
// (onReconnect). Polling only stops for good on an explicit stop().
const MAX_CONSECUTIVE_ERRORS = 10
const SLOW_RETRY_MS = 30000
// Per-request timeout, so a hung Olympus fails the poll instead of stalling it.
const POLL_TIMEOUT_MS = 10000

let config = null
let polling = false
let pollCount = 0
let consecutiveErrors = 0
let unreachable = false
let onDisconnect = null
let onReconnect  = null

let unitsTimer = null
let missionTimer = null
let airbasesTimer = null
let weaponsTimer = null
let missileDetectionTimer = null

let onUnitsDelta  = null
let onWeaponsDelta = null
let onMission     = null
let onAirbases    = null
let onBullseyes   = null

let lastTheatre     = null
let lastSessionHash = null

// Omniscient weapons truth (all coalitions), separate from state.js's
// weapons store — mirrors tacview.js's internalUnits/internalWeapons split.
// Necessary because Olympus's own /olympus/weapons endpoint, unlike
// /olympus/units, sends full unredacted position data for every coalition's
// missiles regardless of which coalition authenticated (confirmed live —
// see missileDetection.js's createMissileFogFilter). state.js's
// weapons store (what a newly-connected browser gets hydrated with) must
// only ever hold the fog-filtered PUBLIC view, matching what's already been
// broadcast — so pollMissileDetection() needs its own omniscient copy to
// compute against.
let internalWeapons = {}
let missileFogFilter = null
let friendlyCoalitionId = null

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
    signal:  AbortSignal.timeout(POLL_TIMEOUT_MS),
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
    signal:  AbortSignal.timeout(POLL_TIMEOUT_MS),
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
    // Olympus's own cursor for the next `?time=` request — must be this
    // poll's real updateTime, never anything else's delta.time (see
    // state.js's setSourceCursorTime comment).
    state.setSourceCursorTime(updateTime)
    if (onUnitsDelta) onUnitsDelta(delta)
    consecutiveErrors = 0
    if (unreachable) {
      unreachable = false
      console.log('[olympus] reachable again - resuming normal polling')
      if (onReconnect) onReconnect()
    }
  } catch (err) {
    consecutiveErrors++
    if (unreachable) {
      console.error(`[olympus] still unreachable, retrying in ${SLOW_RETRY_MS / 1000}s:`, err.message)
    } else {
      console.error(`[olympus] units poll error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, err.message)
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        unreachable = true
        console.error(`[olympus] too many consecutive errors - retrying every ${SLOW_RETRY_MS / 1000}s`)
        if (onDisconnect) onDisconnect()
      }
    }
  } finally {
    if (polling) unitsTimer = setTimeout(pollUnits, unreachable ? SLOW_RETRY_MS : rateConfig.unitUpdateMs)
  }
}

// Weapon objects need two guards real units don't (confirmed against a live
// capture):
// Olympus never purges a dead weapon from its internal registry, so it keeps
// reporting the same id forever — a proper {category, alive:false} on every
// full-refresh poll, and a completely bare {id}-only stub (no position, no
// alive field at all) on every delta poll in between. Skipping any record
// without a `position` catches both cases (every genuine live update always
// carries position); treating alive===false as a removal is naturally
// idempotent (re-removing an already-gone id is a harmless no-op), so no
// permanent tombstone tracking is needed.
async function pollWeapons() {
  if (!polling) return
  if (unreachable) { weaponsTimer = setTimeout(pollWeapons, rateConfig.unitUpdateMs); return }
  try {
    // Always a full fetch (time=0) — per this function's header comment,
    // Olympus's weapons endpoint never streams real position on an
    // incremental (?time=X, X>0) poll, only a bare {id} stub. Relying on
    // FULL_REFRESH_EVERY the way pollUnits() does left real missile position
    // updates landing only once every 10 polls (~10s at 1Hz). Live weapon
    // counts (missiles only) are small
    // enough that a full fetch every poll is cheap, and it's the only way to
    // get real position data every poll.
    const buffer = await fetchOlympusBinary('/olympus/weapons?time=0')
    const { updateTime, units: weapons } = decodeUnits(buffer)

    const updatedMap = {}
    const removedIds = []

    for (const weapon of weapons) {
      if (weapon.alive === false) {
        removedIds.push(String(weapon.id))
        continue
      }
      if (!weapon.position) continue // stale/ghost stub — see comment above
      if (weapon.category !== 'Missile') continue // bombs/shells out of scope for v1
      if (!weaponDatabase.isTrackableMissile(weapon.name)) continue
      updatedMap[String(weapon.id)] = weapon
    }

    // Always a full snapshot now, so any previously-known weapon missing
    // from this response is genuinely gone — no forceFullRefresh gate
    // needed (compared against internalWeapons, the omniscient truth, not
    // state.js's public store — a currently-hidden enemy missile is
    // legitimately absent from the public store while still alive).
    const receivedIds = new Set(weapons.map((w) => String(w.id)))
    for (const knownId of Object.keys(internalWeapons)) {
      if (!receivedIds.has(knownId)) removedIds.push(knownId)
    }

    for (const [id, weapon] of Object.entries(updatedMap)) internalWeapons[id] = weapon
    for (const id of removedIds) {
      delete internalWeapons[id]
      if (missileFogFilter) missileFogFilter.forget(id)
    }

    // Own-coalition/neutral pass straight through; a non-friendly weapon's
    // raw position data is only forwarded once missileFogFilter has actually
    // confirmed it detected — see that filter's own comment for why this
    // redaction is necessary here (Olympus's /olympus/weapons endpoint sends
    // unredacted omniscient data, confirmed live).
    const publicUpdated = missileFogFilter ? missileFogFilter.filterFrameUpdate(updatedMap) : updatedMap

    const delta = { updated: publicUpdated, removed: removedIds, time: updateTime }
    state.applyWeaponsDelta(delta)
    if (onWeaponsDelta) onWeaponsDelta(delta)
  } catch (err) {
    console.error('[olympus] weapons poll error:', err.message)
  } finally {
    if (polling) weaponsTimer = setTimeout(pollWeapons, rateConfig.unitUpdateMs)
  }
}

// AWACS/EWR-only synthetic missile detection (server/src/missileDetection.js)
// — neither Olympus's real units nor its weapon objects carry any native
// detection data for a missile target (Weapon class never populates
// contacts[]/radarState), so this runs independently on its own cadence
// rather than piggybacking on pollUnits()/pollWeapons(), reading the current
// canonical state built up by both. No-op for a gm/admin session
// (missileFogFilter null), matching tacviewDetection.js's fog filter being
// likewise only created for a real blue/red session. Also drives the weapon
// fog-of-war reveal/hide cycle (missileFogFilter.computeVisibility), not
// just the units-side missileContacts[] update.
function pollMissileDetection() {
  if (!polling) return
  try {
    if (missileFogFilter) {
      const units = Object.fromEntries(state.getAllUnitEntries())
      const { contactsUpdate, revealed, hidden } = missileFogFilter.computeVisibility(units, internalWeapons)

      if (Object.keys(contactsUpdate).length > 0) {
        const unitsDelta = { updated: contactsUpdate, removed: [], time: Date.now() }
        state.applyDelta(unitsDelta)
        if (onUnitsDelta) onUnitsDelta(unitsDelta)
      }

      if (Object.keys(revealed).length > 0 || hidden.length > 0) {
        const weaponsDelta = { updated: revealed, removed: hidden, time: Date.now() }
        state.applyWeaponsDelta(weaponsDelta)
        if (onWeaponsDelta) onWeaponsDelta(weaponsDelta)
      }
    }
  } catch (err) {
    console.error('[olympus] missile detection error:', err.message)
  } finally {
    if (polling) missileDetectionTimer = setTimeout(pollMissileDetection, rateConfig.missileDetectionMs)
  }
}

async function pollBullseyes() {
  if (!polling || unreachable) return
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
  if (unreachable) { missionTimer = setTimeout(pollMission, MISSION_INTERVAL_MS); return }
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
  if (unreachable) { airbasesTimer = setTimeout(pollAirbases, AIRBASES_INTERVAL_MS); return }
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
  onWeaponsDelta  = callbacks.onWeaponsDelta  ?? null
  onMission       = callbacks.onMission       ?? null
  onAirbases      = callbacks.onAirbases      ?? null
  onBullseyes     = callbacks.onBullseyes     ?? null
  onDisconnect    = callbacks.onDisconnect    ?? null
  onReconnect     = callbacks.onReconnect     ?? null

  polling = true
  pollCount = 0
  consecutiveErrors = 0
  unreachable = false
  lastTheatre = null
  lastSessionHash = null
  state.resetForNewSource()
  internalWeapons = {}
  friendlyCoalitionId = coalitionId(config.coalition)
  missileFogFilter = friendlyCoalitionId !== null ? missileDetection.createMissileFogFilter(friendlyCoalitionId) : null
  // Olympus has no relay-hosted mode — always local, see server/rateConfig.json.
  rateConfig.resetToLocalConfig()

  console.log(`[olympus] starting polling → ${config.olympusUrl}`)
  pollUnits()
  pollWeapons()
  pollMissileDetection()
  pollMission()
  pollAirbases()
  pollBullseyes()
}

function stop() {
  polling = false
  unreachable = false
  clearTimeout(unitsTimer)
  clearTimeout(weaponsTimer)
  clearTimeout(missileDetectionTimer)
  clearTimeout(missionTimer)
  clearTimeout(airbasesTimer)
  clearTimeout(bullseyesTimer)
  config = null
  internalWeapons = {}
  missileFogFilter = null
  friendlyCoalitionId = null
  console.log('[olympus] polling stopped')
}

function isPolling() {
  return polling
}

// True while polling is in slow-retry mode after repeated failures.
function isUnreachable() {
  return unreachable
}

function getConfig() {
  return config
}

// A fetch failure's underlying cause, in words a controller can act on.
function describeFetchError(err) {
  if (err?.name === 'TimeoutError') return 'no response within 5 s'
  const code = err?.cause?.code
  if (code === 'ECONNREFUSED') return 'connection refused'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'host not found'
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ETIMEDOUT') return 'host unreachable'
  return code ?? err?.message ?? 'unknown error'
}

// Errors carry their own complete message (`describesItself`), so the
// connect route shows them as-is. Only a password rejection is `identified`:
// that's the one answer proving an Olympus is there, which auto-detect uses
// to surface it over the other source types' failures.
async function probe(cfg) {
  const url = `${cfg.olympusUrl}/olympus/mission`
  const authHeader = makeAuthHeader(cfg.password ?? '', cfg.coalition ?? '')
  let res
  try {
    res = await fetch(url, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(5000),
    })
  } catch (err) {
    throw Object.assign(new Error(`Olympus not reachable at ${cfg.olympusUrl} (${describeFetchError(err)})`), { describesItself: true })
  }
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(identifiedError('Olympus rejected the password - check the coalition/role password'), { describesItself: true })
  }
  if (!res.ok) throw Object.assign(new Error(`Olympus at ${cfg.olympusUrl} responded HTTP ${res.status}`), { describesItself: true })
}

module.exports = { start, stop, isPolling, isUnreachable, getConfig, probe }
