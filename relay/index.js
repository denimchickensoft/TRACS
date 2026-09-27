'use strict'

// TRACS relay — standalone application, runs on the DCS server side
// alongside Olympus and SRS (not inside a controller's TRACS backend).
//
// Bootstrap only: loads config, hosts one HTTP server with WebSocket
// upgrades routed by path across this relay's capabilities. Each capability
// is its own module on the same port, dispatched by path; a new capability
// becomes another path, not another port.

const fs = require('fs')
const path = require('path')
const http = require('http')
const { WebSocketServer } = require('ws')
const { createTransponderRelay } = require('./transponders')
const { createSyncRelay }        = require('./syncRelay')
const { createTacviewRelay }     = require('./tacview')
const { checkAndApplyUpdate }    = require('./update')
const { isSeaBinary, RELAY_DIR } = require('./paths')

// config.json (gitignored — holds passwords) overrides env vars, which
// override the built-in defaults. See config.example.json for the shape.
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(RELAY_DIR, 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}
const fileConfig = loadConfig()

// The relay serves every connected controller, so one unexpected error must
// not take it down for all of them: log it with its stack and keep running.
process.on('uncaughtException', (err) => {
  console.error('[relay] uncaught error (relay kept running):', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[relay] unhandled promise rejection (relay kept running):', reason)
})

// Scan-rate intervals are pushed to every connected backend, which uses them
// as timer periods, so a non-numeric or absurd value must never leave here.
function rateMs(key, fileValue, envValue, fallback) {
  const value = Number(fileValue ?? envValue ?? fallback)
  if (Number.isFinite(value) && value >= 100 && value <= 60000) return value
  console.warn(`[relay] config ${key}=${JSON.stringify(fileValue ?? envValue)} is invalid (need 100-60000ms) - using ${fallback}ms`)
  return fallback
}

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
  // original, still-supported open-access posture).
  passwords: (fileConfig.passwords && typeof fileConfig.passwords === 'object' && !Array.isArray(fileConfig.passwords))
    ? fileConfig.passwords
    : {},
  // Radar scan-rate tuning for relay-hosted Tacview sessions — pushed to
  // every connecting controller backend by relay/tacview.js's
  // onAuthenticated(), applied via server/src/rateConfig.js's
  // applyRelayConfig(). Same units/meaning as server/rateConfig.json's
  // unitUpdateMs/detectionMs/missileDetectionMs (see that file's comment for
  // real-world radar scan-rate context) — 1000ms matches this project's
  // original testing-fidelity default; see config.example.json for a more
  // realistic value.
  unitUpdateMs:       rateMs('unitUpdateMs', fileConfig.unitUpdateMs, process.env.UNIT_UPDATE_MS, 1000),
  detectionMs:        rateMs('detectionMs', fileConfig.detectionMs, process.env.DETECTION_MS, 1000),
  missileDetectionMs: rateMs('missileDetectionMs', fileConfig.missileDetectionMs, process.env.MISSILE_DETECTION_MS, 1000),
  // Hand-rolled auto-update — see update.js. Only
  // meaningful when running as the packaged SEA binary (isSeaBinary above);
  // a plain `node index.js` dev run never self-updates. mode: "notify" logs
  // only, "immediate" swaps+exits as soon as a new release is seen,
  // "window" (default) gates that swap+exit to a daily maintenance window so
  // an unannounced restart doesn't drop every live connection.
  autoUpdate: {
    mode:   fileConfig.autoUpdate?.mode ?? 'window',
    window: fileConfig.autoUpdate?.window ?? { start: '04:00', end: '05:00', timezone: 'America/New_York' },
  },
}

// Per-message size caps (ws defaults to 100 MiB, accepted before auth).
// /transponders and /tacview clients only ever send their auth message; /sync
// carries every relay-hosted sync message, the largest being a STATE_DUMP
// (flight plans, declarations, status board), normally well under 1 MiB.
// Missions and drawings are never synced through the relay.
const AUTH_ONLY_MAX_PAYLOAD = 64 * 1024
const SYNC_MAX_PAYLOAD      = 16 * 1024 * 1024

const server = http.createServer()
const transpondersWss = new WebSocketServer({ noServer: true, maxPayload: AUTH_ONLY_MAX_PAYLOAD })
const syncWss          = new WebSocketServer({ noServer: true, maxPayload: SYNC_MAX_PAYLOAD })
const tacviewWss       = new WebSocketServer({ noServer: true, maxPayload: AUTH_ONLY_MAX_PAYLOAD })

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

server.on('error', (err) => {
  const reason = err.code === 'EADDRINUSE' ? `port ${config.wsPort} is already in use` : err.message
  console.error(`[relay] could not listen on :${config.wsPort} - ${reason}`)
  process.exit(1)
})

server.listen(config.wsPort, () => {
  console.log(`[relay] listening on :${config.wsPort} (/transponders, /sync, /tacview)`)
})

// Auto-update only applies to the packaged SEA binary — a dev running
// `node index.js` has no standalone executable to swap out from under
// itself, and would just be repeatedly re-downloading its own source.
if (isSeaBinary) {
  checkAndApplyUpdate(config.autoUpdate, { exePath: process.execPath, exeDir: RELAY_DIR })
    .catch((err) => console.error('[relay:update] check failed:', err.message))
}
