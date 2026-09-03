'use strict'

// TRACS relay — standalone application, runs on the DCS server side
// alongside Olympus and SRS (not inside a controller's TRACS backend).
//
// Bootstrap only: loads config, hosts one HTTP server with WebSocket
// upgrades routed by path across this relay's capabilities. Each capability
// is its own module — see resources/specs/data-sources/
// tracs-relay-architecture-spec.md §2.1 for why, and what's next to land
// here (Tacview-side capture, eventually a native dataminer).

const fs = require('fs')
const path = require('path')
const http = require('http')
const { WebSocketServer } = require('ws')
const { createTransponderRelay } = require('./transponders')
const { createSyncRelay }        = require('./syncRelay')

// config.json (gitignored — holds passwords) overrides env vars, which
// override the built-in defaults. See config.example.json for the shape.
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}
const fileConfig = loadConfig()

const config = {
  srsLotatcPort: Number(fileConfig.srsLotatcPort ?? process.env.SRS_LOTATC_PORT ?? 10712),
  wsPort:        Number(fileConfig.wsPort ?? process.env.RELAY_WS_PORT ?? 8765),
  // Any one of these unlocks the relay — not coalition-scoped, since neither
  // transponder data nor room membership depend on which specific password
  // was used (room privacy for sync comes from the room ID being derived
  // from the password client-side, not from this check). Empty/missing =
  // no auth required (the original, still-supported open-access posture).
  passwords: Array.isArray(fileConfig.passwords) ? fileConfig.passwords : [],
}

const server = http.createServer()
const transpondersWss = new WebSocketServer({ noServer: true })
const syncWss          = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost')
  if (pathname === '/transponders') {
    transpondersWss.handleUpgrade(req, socket, head, (ws) => transpondersWss.emit('connection', ws, req))
  } else if (pathname === '/sync') {
    syncWss.handleUpgrade(req, socket, head, (ws) => syncWss.emit('connection', ws, req))
  } else {
    socket.destroy()
  }
})

createTransponderRelay(transpondersWss, config)
createSyncRelay(syncWss, config)

server.listen(config.wsPort, () => {
  console.log(`[relay] listening on :${config.wsPort} (/transponders, /sync)`)
})
