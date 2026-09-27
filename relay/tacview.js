'use strict'

// Tacview relay capability — connects to a DCS server's Tacview Real-Time
// Telemetry port ONCE, on behalf of every connected controller, and fans the
// parsed data out over WebSocket (mounted at /tacview by relay/index.js).
// Detection enrichment (server/src/tacviewDetection.js) deliberately does
// NOT happen here — it needs theatre-specific terrain/elevation data this
// standalone relay isn't meant to bundle, so it runs per-controller-backend
// instead (server/src/tacviewRelayClient.js), same posture as AGL enrichment
// already has for Olympus. This module only parses and forwards.

const fs = require('fs')
const path = require('path')
const net = require('net')
const { gateConnection } = require('./auth')
const tacviewCore = require('./tacviewCore')
const { RELAY_DIR } = require('./paths')

// Same reconnect policy as the backend's direct Tacview connection
// (server/src/tacview.js): rapid connect/disconnect churn against Tacview's
// Real-Time Telemetry port is known to crash tacview.dll (and DCS with it).
// Backoff starts at RECONNECT_MIN_MS, doubles per failed attempt up to
// RECONNECT_MAX_MS, and resets once telemetry flows. MAX_HANDSHAKE_FAILURES
// closes in a row right after our handshake mean a wrong RTT password, so
// the relay stops retrying instead of cycling the port forever.
const RECONNECT_MIN_MS = 3000
const RECONNECT_MAX_MS = 60000
const MAX_HANDSHAKE_FAILURES = 3
// Real ACMI lines are short; an unterminated one past this size means a
// broken or hostile peer, so drop the connection rather than buffer forever.
const MAX_PARTIAL_LINE = 1024 * 1024

// Relay-operator-owned detection/fog-of-war tuning — gitignored, optional,
// same key shape as server/tacviewDetectionConfig.json. Loaded once at relay startup,
// tolerate-absent, same convention as relay/index.js's own config.json.
// Forwarded to every authenticated /tacview client as-is (no DEFAULTS
// merge/shape validation here — server/src/tacviewDetection.js's
// applyRelayConfig()/mergeConfig() is the one place that happens, exactly
// mirroring how the local-file case already works for direct mode).
const DETECTION_CONFIG_PATH = path.join(RELAY_DIR, 'tacviewDetectionConfig.json')
function loadDetectionConfig() {
  try {
    return JSON.parse(fs.readFileSync(DETECTION_CONFIG_PATH, 'utf8'))
  } catch {
    return {}
  }
}
const detectionConfig = loadDetectionConfig()

function createTacviewRelay(wss, config) {
  let parser = tacviewCore.createParser()
  let lineBuffer = ''
  let socket = null
  let reconnectTimer = null
  let reconnectDelayMs = RECONNECT_MIN_MS
  let handshakeFailures = 0
  let stopped = false

  // Merged running snapshot, so a newly-authenticated client can catch up
  // immediately rather than waiting for the next upstream change — same
  // "full snapshot on connect" convention relay/transponders.js already uses.
  let snapshotUnits = {}
  let snapshotBullseyes = null
  const authenticatedClients = new Set()

  // missionUtcMs rides alongside every message (not just the snapshot) so a
  // connecting backend's tacviewRelayClient.js — which never sees the raw
  // wire itself — can still synthesize a mission clock the same way direct
  // mode's tacview.js does from its own parser (from Tacview's
  // ReferenceTime).
  function broadcast(payload) {
    const msg = JSON.stringify({ type: 'tacview', data: payload, missionUtcMs: parser.getCurrentMissionUtcMs() })
    for (const ws of authenticatedClients) {
      if (ws.readyState === ws.OPEN) ws.send(msg)
    }
  }

  function processIncoming(text) {
    lineBuffer += text
    const lines = lineBuffer.split('\n')
    lineBuffer = lines.pop() ?? ''
    if (lineBuffer.length > MAX_PARTIAL_LINE) {
      console.error(`[relay:tacview] over ${MAX_PARTIAL_LINE} bytes without a line break - dropping the connection`)
      lineBuffer = ''
      socket?.destroy()
      return
    }
    if (!lines.length) return

    const result = parser.parseLines(lines)

    Object.assign(snapshotUnits, result.updated)
    for (const id of result.removed) delete snapshotUnits[id]
    if (result.bullseyes) snapshotBullseyes = result.bullseyes

    if (Object.keys(result.updated).length || result.removed.length || result.bullseyes || result.positions.length) {
      broadcast(result)
    }
  }

  function connect() {
    let handshakeSent = false
    let receivedTelemetry = false
    // Handlers close over this connection's own socket and ignore events
    // once it's no longer the current one, same as server/src/tacview.js.
    const localSocket = net.createConnection({ host: config.tacviewHost, port: config.tacviewPort })
    socket = localSocket

    localSocket.on('connect', () => {
      if (localSocket !== socket) { localSocket.destroy(); return }
      console.log(`[relay:tacview] connected to ${config.tacviewHost}:${config.tacviewPort}`)
    })

    localSocket.on('data', (chunk) => {
      if (localSocket !== socket) return
      if (!handshakeSent) {
        handshakeSent = true
        localSocket.write(tacviewCore.buildClientHandshake('TRACS-Relay', config.tacviewPassword))
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
      parser = tacviewCore.createParser() // fresh per-connection delta state
      lineBuffer = ''
      snapshotUnits = {}
      snapshotBullseyes = null
      if (stopped) return

      if (receivedTelemetry) {
        handshakeFailures = 0
        reconnectDelayMs = RECONNECT_MIN_MS
      } else if (handshakeSent && ++handshakeFailures >= MAX_HANDSHAKE_FAILURES) {
        // Only a close right after our handshake counts as a rejection; a
        // refused connection (no greeting) is Tacview not running yet, e.g.
        // a mission restart, and keeps retrying below.
        console.error(`[relay:tacview] rejected ${handshakeFailures}x in a row right after the handshake - likely a wrong tacviewPassword. Giving up; fix config.json and restart the relay.`)
        return
      }

      const delay = reconnectDelayMs
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS)
      console.log(`[relay:tacview] disconnected from Tacview - reconnecting in ${Math.round(delay / 1000)}s`)
      reconnectTimer = setTimeout(connect, delay)
    })

    localSocket.on('error', (err) => {
      if (localSocket !== socket) return
      console.error(`[relay:tacview] connection error: ${err.code ?? err.name ?? 'unknown'} - ${err.message || '(no message)'}`)
    })
  }

  // Closes the Tacview connection for good (relay shutdown).
  function stop() {
    stopped = true
    clearTimeout(reconnectTimer)
    socket?.destroy()
  }

  if (config.tacviewHost && config.tacviewPort) {
    connect()
  } else {
    console.log('[relay:tacview] no tacviewHost/tacviewPort configured - capability idle')
  }

  wss.on('connection', (ws, req) => {
    gateConnection(ws, config.passwords, {
      req,
      label: 'tacview',
      onAuthenticated: (authMsg) => {
        authenticatedClients.add(ws)
        console.log(`[relay:tacview] client authenticated coalition=${authMsg.coalition} (total: ${authenticatedClients.size})`)
        // Sent before the snapshot, every time — even when detectionConfig
        // is {} for an unconfigured relay. A connecting backend's
        // wait-for-config gate (tacviewRelayClient.js) must only ever block
        // on a relay that doesn't know this message type exists at all,
        // never on one that's simply unconfigured.
        ws.send(JSON.stringify({ type: 'tacviewDetectionConfig', config: detectionConfig }))
        // Radar scan-rate config — unlike detectionConfig, this always has
        // resolved values (config.json → env var → hardcoded default, see
        // relay/index.js), never a bare {}, since every relay operator's
        // scan rate is "something" even if they never touched config.json.
        ws.send(JSON.stringify({
          type: 'tacviewRateConfig',
          config: {
            unitUpdateMs: config.unitUpdateMs,
            detectionMs: config.detectionMs,
            missileDetectionMs: config.missileDetectionMs,
          },
        }))
        ws.send(JSON.stringify({
          type: 'tacview',
          data: {
            updated: snapshotUnits,
            removed: [],
            bullseyes: snapshotBullseyes,
            // Real positions, not []: a client's theatre bbox-vote (see
            // server/src/tacviewRelayClient.js's voteTheatre()) only samples
            // messages with a non-empty positions array, and this snapshot is
            // otherwise its first and richest chance at a sample -- without
            // this, a reconnecting client depends on a live delta happening
            // to carry position-changed units within its one-shot vote
            // window, which a mostly-static mission may never do.
            positions: Object.values(snapshotUnits).map((u) => u.position).filter(Boolean),
          },
          missionUtcMs: parser.getCurrentMissionUtcMs(),
        }))
      },
    })

    ws.on('close', () => {
      if (authenticatedClients.delete(ws)) {
        console.log(`[relay:tacview] client disconnected (total: ${authenticatedClients.size})`)
      }
    })

    ws.on('error', (err) => {
      if (err.code === 'ECONNRESET') return
      console.error('[relay:tacview] client socket error:', err.message)
    })
  })

  return { stop }
}

module.exports = { createTacviewRelay }
