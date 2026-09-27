'use strict'

require('./seedConfigFiles').seedUserConfigDir()

const http = require('http')
const path = require('path')
const express = require('express')
const { WebSocketServer } = require('ws')
const sourceRegistry = require('./sourceRegistry')
const srs        = require('./srs')
const tacviewRelayClient = require('./tacviewRelayClient')
const state      = require('./state')
const stateFiles = require('./stateFiles')
const navdata    = require('../navdata')
const elevation  = require('./elevation')
const { registerApiRoutes } = require('./routes/api')
const { registerSourceConnectRoutes } = require('./routes/sourceConnect')
const { registerDocsRoutes } = require('./routes/docs')
const { createWsBroadcast }  = require('./wsBroadcast')
const { createSignalRelay }  = require('./signalRelay')

// Standalone server (npm start / dev) only: log unexpected errors and keep
// running. Under Electron, electron/main.js's log.errorHandler owns this.
if (!process.versions.electron) {
  process.on('uncaughtException', (err) => console.error('[server] uncaught error:', err))
  process.on('unhandledRejection', (reason) => console.error('[server] unhandled promise rejection:', reason))
}

elevation.init()

const PORT = process.env.PORT ?? 8722
// Loopback only by default: this server's REST/WS endpoints are
// unauthenticated (live picture, /api/connect, state writes), so they must
// not be reachable from the LAN. The UI loads http://localhost:<port>, which
// Chromium and Node both resolve to loopback. TRACS_HOST (e.g. 0.0.0.0) is
// an explicit opt-in for anyone who really needs LAN access.
const HOST = process.env.TRACS_HOST || '127.0.0.1'
const SERVER_INSTANCE_ID = Date.now().toString(36) + Math.random().toString(36).slice(2)
const CLIENT_DIST  = path.join(__dirname, '../../client/dist')

// Browser-origin guard. Any web page open in the user's browser can try to
// reach localhost, so:
//   - Host must be a loopback name (defeats DNS rebinding, where an attacker's
//     domain resolves to 127.0.0.1). Skipped when TRACS_HOST opts in to LAN
//     access, since LAN clients legitimately use other host names.
//   - A browser request carrying Origin must be same-origin (Origin host ==
//     Host header). Every legitimate page — the UI, popups, docs, and the Vite
//     dev server's proxied requests — is same-origin; cross-site pages aren't.
//   - Requests with no Origin (curl, Node clients) aren't browser-driven and
//     are allowed.
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

function isAllowedRequest(req) {
  const host = req.headers.host
  if (!host) return false
  if (!process.env.TRACS_HOST) {
    const hostname = host.replace(/:\d+$/, '').toLowerCase()
    if (!LOOPBACK_HOSTNAMES.has(hostname)) return false
  }
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false // includes Origin: null (file://, sandboxed frames)
  }
}

const app = express()
app.use((req, res, next) => {
  if (isAllowedRequest(req)) return next()
  console.warn(`[server] rejected ${req.method} ${req.url} (host=${req.headers.host}, origin=${req.headers.origin ?? '-'})`)
  res.status(403).send('Forbidden')
})

// Content-Security-Policy, currently REPORT-ONLY: violations are logged to
// the page's DevTools console but nothing is blocked. Once every module has
// run with a clean console, switch the header name to
// Content-Security-Policy to enforce it. connect-src allows any ws/wss host
// because TRACS Relay and Nostr relay addresses are user-configured.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ')
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy-Report-Only', CSP)
  next()
})

app.use(express.json())

registerDocsRoutes(app)

// Serve built client files in production
app.use(express.static(CLIENT_DIST))

// ─── HTTP + WS server ────────────────────────────────────────────────────────

// Per-message size caps (ws defaults to 100 MiB). The browser never sends
// on /ws (it only receives), and /signal carries WebRTC signaling (SDP
// offers/answers, a few KB each).
const server = http.createServer(app)
const wss       = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
const signalWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })

// Route WebSocket upgrade requests by path so both servers share one HTTP port.
server.on('upgrade', (req, socket, head) => {
  if (!isAllowedRequest(req)) {
    console.warn(`[server] rejected WebSocket upgrade ${req.url} (host=${req.headers.host}, origin=${req.headers.origin ?? '-'})`)
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
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
  state, stateFiles, sourceRegistry, tacviewRelayClient, serverInstanceId: SERVER_INSTANCE_ID,
})

createSignalRelay(signalWss)

registerSourceConnectRoutes(app, { sourceRegistry, srs, tacviewRelayClient, state, broadcast })

registerApiRoutes(app, {
  sourceRegistry, tacviewRelayClient, state, stateFiles, navdata, elevation, getWsClientCount,
})

// SRS transponder enrichment — orthogonal to whichever primary source is
// active, not part of sourceRegistry. Connects OUT to a standalone TRACS
// relay (relay/) as a client — this backend never listens for SRS's UDP
// export directly, since that would only ever reach one controller's own
// backend. Optional server-side default — normally set per-session from the
// browser's Login screen instead (routes/api.js's /api/connect), which is
// where most controllers would actually configure this.
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

// Settles once the server is listening, or rejects if it can't bind (e.g.
// EADDRINUSE). electron/main.js awaits it so a failure reaches its startup
// error dialog; run standalone, a bind failure logs and exits instead.
let resolveReady, rejectReady
const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })

server.on('error', (err) => {
  const reason = err.code === 'EADDRINUSE' ? `port ${PORT} is already in use` : err.message
  console.error(`[server] could not listen on ${HOST}:${PORT} - ${reason}`)
  if (require.main === module) process.exit(1)
  rejectReady(new Error(`TRACS server could not listen on ${HOST}:${PORT}: ${reason}`))
})

server.listen(PORT, HOST, () => {
  resolveReady()
  // The signal relay is fresh on every start — any WebRTC peers from the previous
  // run are gone. Clear the persisted clientList so pre-flight frequency checks
  // don't reject new sign-ons based on stale entries.
  // ATC/CATCC state is now authoritative in client localStorage; server-side
  // files are a redundant backup and should not carry over across restarts.
  stateFiles.write('atc',   stateFiles.DEFAULTS.atc)
  stateFiles.write('catcc', stateFiles.DEFAULTS.catcc)
  stateFiles.patch('session', { clientList: [] })
  console.log(`TRACS server running on http://localhost:${PORT}`)
  if (HOST !== '127.0.0.1') {
    console.warn(`[server] WARNING: listening on ${HOST} (TRACS_HOST) - this server has no authentication; anyone who can reach port ${PORT} can read and control it`)
  }
})

// Graceful shutdown (Electron quit, or Ctrl+C / SIGTERM when run
// standalone): stop the data sources and relay clients so their sockets
// close cleanly (Tacview's RTT server is sensitive to abrupt disconnects),
// close browser sockets, then the HTTP server. Resolves when done, or after
// 2 s if something hangs.
let shutdownPromise = null
function shutdown() {
  if (shutdownPromise) return shutdownPromise
  console.log('[server] shutting down')
  shutdownPromise = new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000)
    for (const type of sourceRegistry.SOURCE_TYPES) {
      const source = sourceRegistry.get(type)
      if (source.isPolling()) source.stop()
    }
    tacviewRelayClient.stop()
    srs.stop()
    for (const ws of wss.clients) ws.close(1001, 'server shutting down')
    for (const ws of signalWss.clients) ws.close(1001, 'server shutting down')
    server.close(() => { clearTimeout(timer); resolve() })
    server.closeAllConnections?.()
  })
  return shutdownPromise
}

if (require.main === module) {
  process.on('SIGINT',  () => shutdown().then(() => process.exit(0)))
  process.on('SIGTERM', () => shutdown().then(() => process.exit(0)))
}

module.exports = { ready, shutdown }
