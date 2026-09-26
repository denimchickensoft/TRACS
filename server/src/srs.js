'use strict'

// Relay-client module — connects OUT to a standalone TRACS relay (relay/)
// as a client, the same way olympus.js connects out to Olympus. Merges
// transponder/IFF data onto existing units in state.js by DCS unitId.
// Never creates a unit — an update for an unknown ID is dropped, since the
// relay could in principle be serving a different mission than whatever
// primary source this backend is polling. Fully optional: does nothing
// unless started with a relay URL.

const WebSocket = require('ws')
const state = require('./state')
const { PROTOCOL_VERSION } = require('./protocolVersion')

const RECONNECT_MS = 3000

let ws = null
let onUnitsDelta = null
let relayUrl = null
let password = null
let coalition = null
let intentionalClose = false
let reconnectTimer = null
let knownTransponderIds = new Set()

function applyTransponders(transponders) {
  const incoming = transponders ?? {}
  const incomingIds = new Set()
  const updated = {}

  for (const [srsId, data] of Object.entries(incoming)) {
    const { name, ...iff } = data
    let unit = state.getUnit(srsId)
    let resolvedId = srsId

    // SRS's raw DCS unitId only reliably equals a Tacview-sourced unit's own
    // id for one specific case (a respawning player aircraft, unitId =
    // tacviewObjectId + 0xFFFFFF; see tacviewCore.js) — for
    // every other Tacview unit (AI, or a different player's aircraft) the
    // two ID spaces are simply unrelated, confirmed by the earlier, separate
    // groupID-correlation work. Fall back to matching on name when the
    // direct lookup misses — verified against a raw LotATC capture
    // that SRS's `Name` and a Tacview unit's `unitName` (== Tacview's
    // `Pilot`, tacviewCore.js) match exactly for the same real aircraft, no
    // parsing needed. Harmless no-op for Olympus sessions, where the direct
    // ID lookup should essentially always already succeed — deliberately
    // not gated by source type, since the general "try harder before giving
    // up" rule already produces the right behavior on its own.
    if (!unit && name) {
      const target = name.trim().toLowerCase()
      if (target) {
        const match = state.getAllUnitEntries()
          .find(([, u]) => u.unitName && u.unitName.trim().toLowerCase() === target)
        if (match) { [resolvedId, unit] = match }
      }
    }

    if (!unit) continue // genuinely unknown — drop, don't fabricate

    incomingIds.add(resolvedId)
    // srsCapable is a permanent per-unit latch — set once, never cleared —
    // so consumers can tell "never had SRS" apart from "briefly dropped".
    updated[resolvedId] = { transponder: iff, srsCapable: true }
  }

  // Clear transponder data for units that dropped out of this snapshot
  // (relay-side staleness timeout, SRS client disconnect, player left) —
  // otherwise a stale transponder object lingers forever and the unit never
  // looks disconnected. srsCapable is intentionally not cleared here.
  // Tracks resolvedId (post-fallback), not SRS's raw id, so this still
  // clears correctly for a unit that was only ever reached via the name
  // fallback above.
  for (const id of knownTransponderIds) {
    if (incomingIds.has(id)) continue
    if (!state.getUnit(id)) continue
    updated[id] = { transponder: null }
  }

  knownTransponderIds = incomingIds

  if (Object.keys(updated).length === 0) return

  const delta = { updated, removed: [], time: Date.now() }
  state.applyDelta(delta)
  if (onUnitsDelta) onUnitsDelta(delta)
}

function connect() {
  // The relay mounts the transponder capability at /transponders (one of
  // several capabilities sharing its port).
  const url = `${relayUrl.replace(/\/+$/, '')}/transponders`
  // See tacviewRelayClient.js's identical connect() for the full race
  // explanation -- every handler closes over `socket` (this instance), never
  // the mutable module-level `ws`, and `socket !== ws` guards drop events
  // from a socket a newer connect() has since superseded.
  const socket = new WebSocket(url)
  ws = socket

  socket.on('open', () => {
    if (socket !== ws) { socket.close(); return }
    console.log(`[srs] connected to relay at ${url}`)
    // Always sent, even with no password configured (password stays null/
    // empty) -- the relay's auth gate waits for this message regardless of
    // whether it actually has passwords configured, so it can't be skipped.
    socket.send(JSON.stringify({ type: 'auth', coalition, password, protocolVersion: PROTOCOL_VERSION }))
  })

  socket.on('message', (raw) => {
    if (socket !== ws) return
    let msg
    try {
      msg = JSON.parse(raw.toString('utf8'))
    } catch (err) {
      console.error('[srs] failed to parse relay message:', err.message)
      return
    }
    if (msg.type === 'transponders') applyTransponders(msg.data)
  })

  socket.on('close', (code, reason) => {
    if (socket !== ws) return
    if (intentionalClose) return

    // An explicit password rejection will never resolve itself by retrying —
    // it needs a config change (see the relay's auth.js). Retrying every
    // RECONNECT_MS forever in that case just floods the relay's logs
    // indefinitely for no benefit. Log once and stop, unlike every other
    // close reason (network blip, relay restart), which genuinely is worth
    // retrying.
    if (reason?.toString() === 'invalid password') {
      console.error('[srs] relay rejected our password - not retrying until reconnected with a corrected one')
      ws = null
      return
    }
    // Same reasoning as the password case above — a protocol mismatch needs
    // a software update on one side, not a network retry.
    if (reason?.toString().startsWith('protocol mismatch')) {
      console.error(`[srs] ${reason} - not retrying until one side is updated`)
      ws = null
      return
    }

    console.log(`[srs] disconnected from relay (code ${code}${reason?.length ? `, reason: ${reason}` : ''}) - reconnecting in ${RECONNECT_MS}ms`)
    reconnectTimer = setTimeout(connect, RECONNECT_MS)
  })

  socket.on('error', (err) => {
    if (socket !== ws) return
    console.error(`[srs] relay connection error: ${err.code ?? err.name ?? 'unknown'} - ${err.message || '(no message)'} - url: ${url}`)
  })
}

function start(cfg, callbacks = {}) {
  if (ws) stop()

  relayUrl = cfg.relayUrl
  password = cfg.password ?? null
  coalition = cfg.coalition ?? null
  onUnitsDelta = callbacks.onUnitsDelta ?? null
  intentionalClose = false
  connect()
}

function stop() {
  intentionalClose = true
  clearTimeout(reconnectTimer)
  reconnectTimer = null
  if (ws) {
    ws.close()
    ws = null
  }
  onUnitsDelta = null
  knownTransponderIds = new Set()
  console.log('[srs] stopped')
}

function isConnected() {
  return ws !== null && ws.readyState === WebSocket.OPEN
}

function getConfig() {
  return relayUrl ? { relayUrl, password, coalition } : null
}

module.exports = { start, stop, isConnected, getConfig }
