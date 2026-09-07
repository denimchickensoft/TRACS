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
const { createTacviewRelay }     = require('./tacview')

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
  // Tacview relay-hosted mode — optional. Left unset (both empty), the
  // capability stays idle (see tacview.js's own guard) rather than trying to
  // connect anywhere. Same posture as SRS: an operator opts in by setting
  // both, defaulting the port to Tacview's own DCS-side default (42674).
  tacviewHost: fileConfig.tacviewHost ?? process.env.TACVIEW_HOST ?? '',
  tacviewPort: Number(fileConfig.tacviewPort ?? process.env.TACVIEW_PORT ?? 42674),
  // Tacview RTT's own export password (its "Real-Time Telemetry password" in
  // options.lua) — a relay-operator secret, since the relay is the only thing
  // that ever connects out to the real DCS server in this mode. Distinct from
  // `passwords` above (which gates browsers/backends connecting IN to this relay).
  tacviewPassword: fileConfig.tacviewPassword ?? process.env.TACVIEW_PASSWORD ?? '',
  // { coalition: password } map — gates *connecting as* a specific
  // coalition (a Red client can't authenticate as Blue by supplying Red's
  // own password under a false coalition claim), checked per-connection by
  // relay/auth.js's gateConnection(). Empty/missing = no auth required (the
  // original, still-supported open-access posture). See
  // resources/specs/data-sources/webrtc-centralized-sync-spec.md §5.
  passwords: (fileConfig.passwords && typeof fileConfig.passwords === 'object' && !Array.isArray(fileConfig.passwords))
    ? fileConfig.passwords
    : {},
}

const server = http.createServer()
const transpondersWss = new WebSocketServer({ noServer: true })
const syncWss          = new WebSocketServer({ noServer: true })
const tacviewWss       = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost')
  if (pathname === '/transponders') {
    transpondersWss.handleUpgrade(req, socket, head, (ws) => transpondersWss.emit('connection', ws, req))
  } else if (pathname === '/sync') {
    syncWss.handleUpgrade(req, socket, head, (ws) => syncWss.emit('connection', ws, req))
  } else if (pathname === '/tacview') {
    tacviewWss.handleUpgrade(req, socket, head, (ws) => tacviewWss.emit('connection', ws, req))
  } else {
    socket.destroy()
  }
})

createTransponderRelay(transpondersWss, config)
createSyncRelay(syncWss, config)
createTacviewRelay(tacviewWss, config)

server.listen(config.wsPort, () => {
  console.log(`[relay] listening on :${config.wsPort} (/transponders, /sync, /tacview)`)
})
