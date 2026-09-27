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
// A missing config.json is fine (defaults/env vars). One that exists but
// can't be parsed stops the relay: silently falling back to {} would also
// drop its passwords and open the relay to everyone.
function loadConfig() {
  const file = path.join(RELAY_DIR, 'config.json')
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    console.error(`[relay] could not read ${file}: ${err.message}`)
    process.exit(1)
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    throw new Error('top level must be a JSON object')
  } catch (err) {
    console.error(`[relay] ${file} is not valid JSON (${err.message}) - fix it or remove it; refusing to start`)
    process.exit(1)
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

// Ports have no safe fallback (silently listening somewhere else would be
// worse), so an invalid one stops the relay.
function port(key, fileValue, envValue, fallback) {
  const value = Number(fileValue ?? envValue ?? fallback)
  if (Number.isInteger(value) && value >= 1 && value <= 65535) return value
  console.error(`[relay] config ${key}=${JSON.stringify(fileValue ?? envValue)} is not a valid port (1-65535) - refusing to start`)
  process.exit(1)
}

function stringValue(key, value) {
  if (value === undefined || typeof value === 'string') return value
  console.warn(`[relay] config ${key} must be a string - ignoring ${JSON.stringify(value)}`)
  return undefined
}

// A non-string password would never match what a client sends, so treat it
// as a config error rather than guessing what was meant.
function passwordsMap(value) {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    console.error('[relay] config passwords must be an object of { coalition: "password" } - refusing to start')
    process.exit(1)
  }
  for (const [coalition, password] of Object.entries(value)) {
    if (typeof password !== 'string') {
      console.error(`[relay] config passwords.${coalition} must be a string - refusing to start`)
      process.exit(1)
    }
  }
  return value
}

const DEFAULT_UPDATE_WINDOW = { start: '04:00', end: '05:00', timezone: 'America/New_York' }
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

function isValidTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}

// Invalid auto-update settings fall back to the defaults with a warning; a
// bad value here would otherwise only surface as an error at update time.
function autoUpdateConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  let mode = cfg.mode ?? 'window'
  if (!['notify', 'immediate', 'window'].includes(mode)) {
    console.warn(`[relay] config autoUpdate.mode=${JSON.stringify(mode)} is invalid (notify, immediate or window) - using "window"`)
    mode = 'window'
  }
  let window = cfg.window ?? DEFAULT_UPDATE_WINDOW
  const windowOk = window && typeof window === 'object'
    && HHMM.test(window.start) && HHMM.test(window.end) && isValidTimezone(window.timezone)
  if (!windowOk) {
    console.warn(`[relay] config autoUpdate.window=${JSON.stringify(window)} is invalid (start/end "HH:MM", an IANA timezone) - using ${JSON.stringify(DEFAULT_UPDATE_WINDOW)}`)
    window = DEFAULT_UPDATE_WINDOW
  }
  return { mode, window }
}

const config = {
  srsLotatcPort: port('srsLotatcPort', fileConfig.srsLotatcPort, process.env.SRS_LOTATC_PORT, 10712),
  wsPort:        port('wsPort', fileConfig.wsPort, process.env.RELAY_WS_PORT, 8765),
  // Tacview relay-hosted mode — optional. Left unset (both empty), the
  // capability stays idle (see tacview.js's own guard) rather than trying to
  // connect anywhere. Same posture as SRS: an operator opts in by setting
  // both, defaulting the port to Tacview's own DCS-side default (42674).
  tacviewHost: stringValue('tacviewHost', fileConfig.tacviewHost) ?? process.env.TACVIEW_HOST ?? '',
  tacviewPort: port('tacviewPort', fileConfig.tacviewPort, process.env.TACVIEW_PORT, 42674),
  // Tacview RTT's own export password (its "Real-Time Telemetry password" in
  // options.lua) — a relay-operator secret, since the relay is the only thing
  // that ever connects out to the real DCS server in this mode. Distinct from
  // `passwords` above (which gates browsers/backends connecting IN to this relay).
  tacviewPassword: stringValue('tacviewPassword', fileConfig.tacviewPassword) ?? process.env.TACVIEW_PASSWORD ?? '',
  // { coalition: password } map — gates *connecting as* a specific
  // coalition (a Red client can't authenticate as Blue by supplying Red's
  // own password under a false coalition claim), checked per-connection by
  // relay/auth.js's gateConnection(). Empty/missing = no auth required (the
  // original, still-supported open-access posture).
  passwords: passwordsMap(fileConfig.passwords),
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
  autoUpdate: autoUpdateConfig(fileConfig.autoUpdate),
}

// Per-message size caps (ws defaults to 100 MiB, accepted before auth).
// /transponders and /tacview clients only ever send their auth message; /sync
// carries every relay-hosted sync message, the largest being a STATE_DUMP
// (flight plans, declarations, status board), normally well under 1 MiB.
// Missions and drawings are never synced through the relay.
const AUTH_ONLY_MAX_PAYLOAD = 64 * 1024
const SYNC_MAX_PAYLOAD      = 16 * 1024 * 1024

// GET /health, for supervisors and operators checking a relay is up and
// which version it runs. Everything else over plain HTTP is a 404; the
// capabilities themselves are WebSocket upgrades (below).
const { version: RELAY_VERSION } = require('./package.json')
const { PROTOCOL_VERSION } = require('./protocolVersion')
const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost')
  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status:          'ok',
      version:         RELAY_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      uptimeS:         Math.round(process.uptime()),
      capabilities: {
        transponders: true,
        sync:         true,
        tacview:      !!(config.tacviewHost && config.tacviewPort),
      },
    }))
    return
  }
  res.writeHead(404).end()
})
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
const syncRelay    = createSyncRelay(syncWss, config)
const tacviewRelay = createTacviewRelay(tacviewWss, config)

// Graceful shutdown (Ctrl+C, a service manager's SIGTERM, or an auto-update
// restart): flush the debounced sessions.json write so a restart doesn't lose
// the latest sessions, close the Tacview connection and every client socket
// cleanly (clients reconnect on their own backoff), then exit. A 3 s timer
// forces the exit if something hangs.
let shuttingDown = false
function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[relay] shutting down (${reason})`)
  setTimeout(() => process.exit(exitCode), 3000).unref()
  syncRelay.flush()
  tacviewRelay.stop()
  for (const wss of [transpondersWss, syncWss, tacviewWss]) {
    for (const ws of wss.clients) ws.close(1001, 'relay shutting down')
  }
  server.close(() => process.exit(exitCode))
  // server.close waits for open HTTP keep-alive connections; don't let one
  // hold the exit up to the 3 s timer.
  server.closeAllConnections?.()
}
process.on('SIGINT',  () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

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
  checkAndApplyUpdate(config.autoUpdate, { exePath: process.execPath, exeDir: RELAY_DIR, shutdown })
    .catch((err) => console.error('[relay:update] check failed:', err.message))
}
