'use strict'

const http = require('http')
const path = require('path')
const express = require('express')
const { WebSocketServer } = require('ws')
const sourceRegistry = require('./sourceRegistry')
const srs        = require('./srs')
const state      = require('./state')
const stateFiles = require('./stateFiles')
const navdata    = require('../navdata')
const elevation  = require('./elevation')
const { registerApiRoutes } = require('./routes/api')
const { createWsBroadcast }  = require('./wsBroadcast')
const { createSignalRelay }  = require('./signalRelay')

elevation.init()

const PORT = process.env.PORT ?? 3000
const SERVER_INSTANCE_ID = Date.now().toString(36) + Math.random().toString(36).slice(2)
const CLIENT_DIST  = path.join(__dirname, '../../client/dist')
const PRESETS_PATH = path.join(__dirname, '../data/presets.json')

const app = express()
app.use(express.json())

// Serve built client files in production
app.use(express.static(CLIENT_DIST))

// ─── HTTP + WS server ────────────────────────────────────────────────────────

const server = http.createServer(app)
const wss       = new WebSocketServer({ noServer: true })
const signalWss = new WebSocketServer({ noServer: true })

// Route WebSocket upgrade requests by path so both servers share one HTTP port.
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost')
  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  } else if (pathname === '/signal') {
    signalWss.handleUpgrade(req, socket, head, (ws) => signalWss.emit('connection', ws, req))
  } else {
    socket.destroy()
  }
})

const { broadcast, getWsClientCount } = createWsBroadcast(wss, {
  state, stateFiles, sourceRegistry, serverInstanceId: SERVER_INSTANCE_ID,
})

createSignalRelay(signalWss)

registerApiRoutes(app, {
  sourceRegistry, srs, state, stateFiles, navdata, elevation, broadcast, getWsClientCount,
  presetsPath: PRESETS_PATH,
})

// SRS transponder enrichment — orthogonal to whichever primary source is
// active, not part of sourceRegistry. Connects OUT to a standalone TRACS
// relay (relay/) as a client — this backend never listens for SRS's UDP
// export directly, since that would only ever reach one controller's own
// backend. Optional server-side default — normally set per-session from the
// browser's Login screen instead (routes/api.js's /api/connect), which is
// where most controllers would actually configure this.
// See resources/specs/data-sources/tracs-relay-architecture-spec.md and
// resources/specs/data-sources/custom-datasource-srs-transponder-spec.md.
if (process.env.TRACS_RELAY_URL) {
  srs.start(
    { relayUrl: process.env.TRACS_RELAY_URL },
    { onUnitsDelta: (delta) => broadcast({ type: 'units_delta', data: delta }) },
  )
}

// Fallback: serve index.html for SPA routes (production only)
app.get('*', (req, res) => {
  res.sendFile(path.join(CLIENT_DIST, 'index.html'))
})

// Start navdata build in the background — does not block HTTP server startup.
// Endpoints return 503 until the cache is ready.
navdata.init().catch((err) => console.error('[navdata] unexpected init error:', err.message))

server.listen(PORT, () => {
  // The signal relay is fresh on every start — any WebRTC peers from the previous
  // run are gone. Clear the persisted clientList so pre-flight frequency checks
  // don't reject new sign-ons based on stale entries.
  // ATC/CATCC state is now authoritative in client localStorage; server-side
  // files are a redundant backup and should not carry over across restarts.
  stateFiles.write('atc',   stateFiles.DEFAULTS.atc)
  stateFiles.write('catcc', stateFiles.DEFAULTS.catcc)
  stateFiles.patch('session', { clientList: [] })
  console.log(`TRACS server running on http://localhost:${PORT}`)
})
