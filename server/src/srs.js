'use strict'

// Relay-client module — connects OUT to a standalone TRACS relay (relay/)
// as a client, the same way olympus.js connects out to Olympus. Merges
// transponder/IFF data onto existing units in state.js by DCS unitId.
// Never creates a unit — an update for an unknown ID is dropped, since the
// relay could in principle be serving a different mission than whatever
// primary source this backend is polling. Fully optional: does nothing
// unless started with a relay URL.
//
// See resources/specs/data-sources/tracs-relay-architecture-spec.md,
// resources/specs/data-sources/custom-datasource-srs-transponder-spec.md,
// and resources/specs/transponder-correlation-spec.md.

const WebSocket = require('ws')
const state = require('./state')

const RECONNECT_MS = 3000

let ws = null
let onUnitsDelta = null
let relayUrl = null
let password = null
let intentionalClose = false
let reconnectTimer = null
let knownTransponderIds = new Set()

function applyTransponders(transponders) {
  const incoming = transponders ?? {}
  const incomingIds = new Set(Object.keys(incoming))
  const updated = {}

  for (const [id, transponder] of Object.entries(incoming)) {
    if (!state.getUnit(id)) continue // unknown unit — drop, don't fabricate
    // srsCapable is a permanent per-unit latch — set once, never cleared —
    // so consumers can tell "never had SRS" apart from "briefly dropped"
    // (see transponder-correlation-spec.md §2).
    updated[id] = { transponder, srsCapable: true }
  }

  // Clear transponder data for units that dropped out of this snapshot
  // (relay-side staleness timeout, SRS client disconnect, player left) —
  // otherwise a stale transponder object lingers forever and the unit never
  // looks disconnected. srsCapable is intentionally not cleared here.
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
  // several capabilities sharing its port) — see
  // resources/specs/data-sources/tracs-relay-architecture-spec.md §2.1.
  const url = `${relayUrl.replace(/\/+$/, '')}/transponders`
  ws = new WebSocket(url)

  ws.on('open', () => {
    console.log(`[srs] connected to relay at ${url}`)
    // Always sent, even with no password configured (password stays null/
    // empty) -- the relay's auth gate waits for this message regardless of
    // whether it actually has passwords configured, so it can't be skipped.
    ws.send(JSON.stringify({ type: 'auth', password }))
  })

  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString('utf8'))
    } catch (err) {
      console.error('[srs] failed to parse relay message:', err.message)
      return
    }
    if (msg.type === 'transponders') applyTransponders(msg.data)
  })

  ws.on('close', (code, reason) => {
    if (intentionalClose) return

    // An explicit password rejection will never resolve itself by retrying —
    // it needs a config change (see the relay's auth.js). Retrying every
    // RECONNECT_MS forever in that case just floods the relay's logs
    // indefinitely for no benefit. Log once and stop, unlike every other
    // close reason (network blip, relay restart), which genuinely is worth
    // retrying.
    if (reason?.toString() === 'invalid password') {
      console.error('[srs] relay rejected our password — not retrying until reconnected with a corrected one')
      ws = null
      return
    }

    console.log(`[srs] disconnected from relay (code ${code}${reason?.length ? `, reason: ${reason}` : ''}) — reconnecting in ${RECONNECT_MS}ms`)
    reconnectTimer = setTimeout(connect, RECONNECT_MS)
  })

  ws.on('error', (err) => {
    console.error(`[srs] relay connection error: ${err.code ?? err.name ?? 'unknown'} — ${err.message || '(no message)'} — url: ${url}`)
  })
}

function start(cfg, callbacks = {}) {
  if (ws) stop()

  relayUrl = cfg.relayUrl
  password = cfg.password ?? null
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
  return relayUrl ? { relayUrl, password } : null
}

module.exports = { start, stop, isConnected, getConfig }
