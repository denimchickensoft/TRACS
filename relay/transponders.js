'use strict'

// Transponder relay capability — listens to SRS's LotATC UDP export locally
// and serves the resulting data over WebSocket (mounted at /transponders by
// relay/index.js) to any number of independently-running TRACS backends
// that connect to it as clients.

const dgram = require('dgram')
const { gateConnection } = require('./auth')

const STALE_AFTER_MS = 10_000

function createTransponderRelay(wss, config) {
  let transponders = {}   // DCS unitId (string) → { mode1, mode2, mode3, mode4, status }
  let lastPacketAt = 0
  const authenticatedClients = new Set()

  function broadcast() {
    const payload = JSON.stringify({ type: 'transponders', data: transponders })
    for (const ws of authenticatedClients) {
      if (ws.readyState === ws.OPEN) ws.send(payload)
    }
  }

  // ─── SRS LotATC UDP listener ────────────────────────────────────────────
  const udpSocket = dgram.createSocket('udp4')

  udpSocket.on('message', (msg) => {
    lastPacketAt = Date.now()

    let data
    try {
      data = JSON.parse(msg.toString('utf8'))
    } catch (err) {
      console.error('[relay:transponders] failed to parse LotATC packet:', err.message)
      return
    }

    // Anyone who can reach this UDP port can send it anything, so validate
    // the shape instead of trusting it — one bad packet must not crash the
    // relay.
    if (!data || typeof data !== 'object' || (data.Clients != null && !Array.isArray(data.Clients))) {
      console.error('[relay:transponders] ignoring LotATC packet with unexpected shape')
      return
    }

    const next = {}
    for (const client of data.Clients ?? []) {
      if (!client || typeof client !== 'object') continue
      const unitId = client.RadioInfo?.unitId
      const iff = client.RadioInfo?.iff
      if (!unitId || !iff) continue
      next[String(unitId)] = {
        mode1:  iff.mode1,
        mode2:  iff.mode2,
        mode3:  iff.mode3,
        mode4:  iff.mode4,
        status: iff.status,
        // Correlation aid only, not an IFF field -- lets a backend fall back
        // to name-matching when unitId doesn't line up with its own unit
        // list (true for every Tacview-sourced unit except a respawning
        // player aircraft -- see server/src/srs.js's applyTransponders()).
        name:   client.Name ?? '',
      }
    }
    transponders = next
    broadcast()
  })

  udpSocket.on('error', (err) => console.error('[relay:transponders] UDP socket error:', err.message))
  udpSocket.bind(config.srsLotatcPort, () => {
    console.log(`[relay:transponders] listening for SRS LotATC export on :${config.srsLotatcPort}`)
  })

  // Clears transponder data for connected clients if SRS has gone quiet,
  // rather than serving stale squawks indefinitely.
  setInterval(() => {
    if (Date.now() - lastPacketAt <= STALE_AFTER_MS) return
    if (Object.keys(transponders).length === 0) return
    console.warn(`[relay:transponders] no LotATC packet in ${STALE_AFTER_MS}ms - clearing transponder data`)
    transponders = {}
    broadcast()
  }, STALE_AFTER_MS)

  // ─── Client-facing WebSocket ─────────────────────────────────────────────
  wss.on('connection', (ws) => {
    gateConnection(ws, config.passwords, {
      label: 'transponders',
      onAuthenticated: (authMsg) => {
        authenticatedClients.add(ws)
        console.log(`[relay:transponders] client authenticated coalition=${authMsg.coalition} (total: ${authenticatedClients.size})`)
        ws.send(JSON.stringify({ type: 'transponders', data: transponders }))
      },
    })

    ws.on('close', () => {
      if (authenticatedClients.delete(ws)) {
        console.log(`[relay:transponders] client disconnected (total: ${authenticatedClients.size})`)
      }
    })

    ws.on('error', (err) => {
      if (err.code === 'ECONNRESET') return
      console.error('[relay:transponders] client socket error:', err.message)
    })
  })
}

module.exports = { createTransponderRelay }
