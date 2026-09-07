'use strict'

// Tacview relay capability — connects to a DCS server's Tacview Real-Time
// Telemetry port ONCE, on behalf of every connected controller, and fans the
// parsed data out over WebSocket (mounted at /tacview by relay/index.js).
// Detection enrichment (server/src/tacviewDetection.js) deliberately does
// NOT happen here — it needs theatre-specific terrain/elevation data this
// standalone relay isn't meant to bundle, so it runs per-controller-backend
// instead (server/src/tacviewRelayClient.js), same posture as AGL enrichment
// already has for Olympus. This module only parses and forwards.
//
// See resources/specs/data-sources/custom-datasource-tacview-spec.md §0.1.

const net = require('net')
const { gateConnection } = require('./auth')
const tacviewCore = require('./tacviewCore')

const RECONNECT_MS = 3000

function createTacviewRelay(wss, config) {
  let parser = tacviewCore.createParser()
  let lineBuffer = ''
  let socket = null

  // Merged running snapshot, so a newly-authenticated client can catch up
  // immediately rather than waiting for the next upstream change — same
  // "full snapshot on connect" convention relay/transponders.js already uses.
  let snapshotUnits = {}
  let snapshotBullseyes = null
  const authenticatedClients = new Set()

  // missionUtcMs rides alongside every message (not just the snapshot) so a
  // connecting backend's tacviewRelayClient.js — which never sees the raw
  // wire itself — can still synthesize a mission clock the same way direct
  // mode's tacview.js does from its own parser. See custom-datasource-
  // tacview-spec.md §5 item 2's ReferenceTime finding.
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
    socket = net.createConnection({ host: config.tacviewHost, port: config.tacviewPort })

    socket.on('connect', () => {
      console.log(`[relay:tacview] connected to ${config.tacviewHost}:${config.tacviewPort}`)
    })

    socket.on('data', (chunk) => {
      if (!handshakeSent) {
        handshakeSent = true
        socket.write(tacviewCore.buildClientHandshake('TRACS-Relay', config.tacviewPassword))
        const text = chunk.toString('utf8')
        const nullIdx = text.indexOf('\0')
        const remainder = nullIdx === -1 ? '' : text.slice(nullIdx + 1)
        if (remainder) processIncoming(remainder)
        return
      }
      processIncoming(chunk.toString('utf8'))
    })

    socket.on('close', () => {
      console.log(`[relay:tacview] disconnected from Tacview — reconnecting in ${RECONNECT_MS}ms`)
      parser = tacviewCore.createParser() // fresh per-connection delta state
      lineBuffer = ''
      snapshotUnits = {}
      snapshotBullseyes = null
      setTimeout(connect, RECONNECT_MS)
    })

    socket.on('error', (err) => {
      console.error(`[relay:tacview] connection error: ${err.code ?? err.name ?? 'unknown'} — ${err.message || '(no message)'}`)
    })
  }

  if (config.tacviewHost && config.tacviewPort) {
    connect()
  } else {
    console.log('[relay:tacview] no tacviewHost/tacviewPort configured — capability idle')
  }

  wss.on('connection', (ws) => {
    gateConnection(ws, config.passwords, {
      label: 'tacview',
      onAuthenticated: (authMsg) => {
        authenticatedClients.add(ws)
        console.log(`[relay:tacview] client authenticated coalition=${authMsg.coalition} (total: ${authenticatedClients.size})`)
        ws.send(JSON.stringify({
          type: 'tacview',
          data: { updated: snapshotUnits, removed: [], bullseyes: snapshotBullseyes, positions: [] },
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
}

module.exports = { createTacviewRelay }
