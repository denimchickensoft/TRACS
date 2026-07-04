'use strict'

const http = require('http')
const path = require('path')
const express = require('express')
const { WebSocketServer } = require('ws')
const olympus    = require('./olympus')
const state      = require('./state')
const maps       = require('./maps')
const stateFiles = require('./stateFiles')
const navdata    = require('../navdata')
const elevation  = require('./elevation')

elevation.init()

const fs = require('fs')

const PORT = process.env.PORT ?? 3000
const SERVER_INSTANCE_ID = Date.now().toString(36) + Math.random().toString(36).slice(2)
const CLIENT_DIST  = path.join(__dirname, '../../client/dist')
const PRESETS_PATH = path.join(__dirname, '../data/presets.json')

const app = express()
app.use(express.json())

// Serve built client files in production
app.use(express.static(CLIENT_DIST))

// ─── API ────────────────────────────────────────────────────────────────────

// POST /api/connect — start Olympus polling with supplied credentials
app.post('/api/connect', async (req, res) => {
  const { olympusUrl, password, coalition } = req.body ?? {}

  if (!olympusUrl) {
    return res.status(400).json({ error: 'olympusUrl is required' })
  }

  // Skip probe + restart only when already polling the same Olympus URL — a
  // simultaneous probe to the same server triggers a 426 from Olympus.
  // If the URL differs this is a reconnect to a different server, so probe and restart.
  const alreadyOnSameServer = olympus.isPolling() && olympus.getConfig()?.olympusUrl === olympusUrl
  if (!alreadyOnSameServer) {
    try {
      await olympus.probe({ olympusUrl, password: password ?? '', coalition: coalition ?? 'blue' })
    } catch (err) {
      return res.status(502).json({ error: `Cannot reach Olympus: ${err.message}` })
    }

    olympus.start(
      { olympusUrl, password: password ?? '', coalition: coalition ?? 'blue' },
      {
        onUnitsDelta:   (delta) => broadcast({ type: 'units_delta', data: delta }),
        onMission:      (data)  => broadcast({ type: 'mission',    data }),
        onAirbases:     (data)  => broadcast({ type: 'airbases',  data }),
        onBullseyes:    (data)  => broadcast({ type: 'bullseyes', data }),
        onDisconnect:   ()      => broadcast({ type: 'status', data: { polling: false, reason: 'olympus_unreachable' } }),
      }
    )
    broadcast({ type: 'units_clear' })
  }

  // Notify all currently-connected WS clients that polling has started (or is
  // already running). This covers new browser windows joining an active session.
  broadcast({ type: 'status', data: { polling: true } })

  res.json({ ok: true })
})


// GET /api/maps?theatre=Caucasus
app.get('/api/maps', async (req, res) => {
  const { theatre } = req.query
  if (!theatre) return res.status(400).json({ error: 'theatre is required' })
  try {
    const result = await maps.loadTheatre(theatre)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/debug/units — live unit snapshot (dev/debug)
app.get('/api/debug/units', (req, res) => {
  const { updated } = state.getSnapshot()
  res.json(updated)
})

// GET /api/navdata/* — Navigraph navdata endpoints
app.get('/api/navdata/status',      navdata.handleStatus)
app.get('/api/navdata/airspace',    navdata.handleAirspace)
app.get('/api/navdata/fixes',       navdata.handleFixes)
app.get('/api/navdata/navaids',     navdata.handleNavaids)
app.get('/api/navdata/procedures',  navdata.handleProcedures)
app.get('/api/navdata/frequencies', navdata.handleFrequencies)
app.get('/api/navdata/ctrs',        navdata.handleCtrFacilities)
app.get('/api/navdata/sector',      navdata.handleSector)
app.get('/api/navdata/holdings',    navdata.handleHoldings)
app.get('/api/navdata/airways',     navdata.handleAirways)
app.get('/api/navdata/msa',         navdata.handleMsa)
app.get('/api/navdata/mora',        navdata.handleMora)
app.get('/api/navdata/relief',      navdata.handleRelief)
app.get('/api/navdata/mva',         navdata.handleMva)
app.get('/api/navdata/geo',         navdata.handleGeo)
app.get('/api/navdata/palettes',    navdata.handlePalettes)

// GET /api/airports/polygons/:theatre — airport surface polygon GeoJSON for ASDE-X
app.get('/api/airports/polygons/:theatre', (req, res) => {
  const { theatre } = req.params
  const folder = navdata.theatreFolder(theatre)
  if (!folder) return res.status(404).json({ error: `unknown theatre: ${theatre}` })
  const filePath = path.join(__dirname, '../navdata/cache', folder, 'airports_polygons.json')
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'no surface data for this theatre' })
  res.sendFile(filePath)
})

// GET /api/airports/names/:theatre — reversed name map: { dcsName: stemName }
app.get('/api/airports/names/:theatre', (req, res) => {
  const { theatre } = req.params
  const mapPath = path.join(__dirname, '../navdata/config/airport_name_map.json')
  if (!fs.existsSync(mapPath)) return res.status(404).json({ error: 'name map not found' })
  try {
    const fullMap  = JSON.parse(fs.readFileSync(mapPath, 'utf8'))
    const theatreMap = fullMap[theatre] ?? {}
    const reversed = {}
    for (const [stem, dcsName] of Object.entries(theatreMap)) reversed[dcsName] = stem
    res.json(reversed)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/asdex/colors — ASDE-X display colors config
app.get('/api/asdex/colors', (req, res) => {
  const filePath = path.join(__dirname, '../navdata/config/asdex_colors.json')
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'colors config not found' })
  try {
    res.json(JSON.parse(fs.readFileSync(filePath, 'utf8')))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/turn-credentials — ICE server list for WebRTC peers
// Set TURN_URL / TURN_USER / TURN_PASS env vars to include a TURN relay.
app.get('/api/turn-credentials', (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]
  if (process.env.TURN_URL) {
    iceServers.push({
      urls:       process.env.TURN_URL,
      username:   process.env.TURN_USER ?? '',
      credential: process.env.TURN_PASS ?? '',
    })
  }
  res.json({ iceServers })
})

// GET /api/status
app.get('/api/status', (req, res) => {
  res.json({ polling: olympus.isPolling() })
})

// GET /api/debug — inspect current in-memory state (dev only)
app.get('/api/debug', (req, res) => {
  const snapshot = state.getSnapshot()
  const unitList = Object.values(snapshot.updated)
  res.json({
    polling: olympus.isPolling(),
    wsClients: clients.size,
    unitCount: unitList.length,
    lastUpdateTime: snapshot.time,
    mission: state.getMission(),
    airbases: state.getAirbases(),
    bullseyes: state.getBullseyes(),
    units: unitList,
  })
})

// GET /api/presets — load saved preset slots from disk
app.get('/api/presets', (req, res) => {
  try {
    if (!fs.existsSync(PRESETS_PATH)) return res.json({ slots: Array(12).fill(null) })
    res.json(JSON.parse(fs.readFileSync(PRESETS_PATH, 'utf8')))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/presets — persist preset slots to disk
app.post('/api/presets', (req, res) => {
  try {
    const dir = path.dirname(PRESETS_PATH)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(PRESETS_PATH, JSON.stringify(req.body, null, 2))
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── State file API ──────────────────────────────────────────────────────────

// POST /api/state/intentional-reset — must be declared before the :key route
app.post('/api/state/intentional-reset', (req, res) => {
  try {
    stateFiles.setIntentionalReset(true)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/state/:key — read atc | catcc | session
app.get('/api/state/:key', (req, res) => {
  const { key } = req.params
  if (!stateFiles.isValidKey(key)) return res.status(400).json({ error: 'invalid state key' })
  res.json(stateFiles.read(key))
})

// POST /api/state/:key — overwrite atc | catcc | session
app.post('/api/state/:key', (req, res) => {
  const { key } = req.params
  if (!stateFiles.isValidKey(key)) return res.status(400).json({ error: 'invalid state key' })
  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'body must be a JSON object' })
  try {
    stateFiles.write(key, req.body)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PATCH /api/state/:key — shallow-merge updates into atc | catcc | session
app.patch('/api/state/:key', (req, res) => {
  const { key } = req.params
  if (!stateFiles.isValidKey(key)) return res.status(400).json({ error: 'invalid state key' })
  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'body must be a JSON object' })
  try {
    stateFiles.patch(key, req.body)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Fallback: serve index.html for SPA routes (production only)
app.get('*', (req, res) => {
  res.sendFile(path.join(CLIENT_DIST, 'index.html'))
})

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

// ─── Trystero signal relay ───────────────────────────────────────────────────
// Simple WebSocket pub/sub broker implementing the @trystero-p2p/ws-relay
// server protocol. Browsers connect here instead of public Nostr relays so
// signaling is local and reliable for LAN/offline deployments.
const signalTopics = new Map()      // topic → Set<WebSocket>
const signalSocks  = new WeakMap()  // WebSocket → Set<topic>

function sigSubscribe(ws, topic) {
  let subs = signalTopics.get(topic)
  if (!subs) { subs = new Set(); signalTopics.set(topic, subs) }
  subs.add(ws)
  let mine = signalSocks.get(ws)
  if (!mine) { mine = new Set(); signalSocks.set(ws, mine) }
  mine.add(topic)
}

function sigUnsubscribe(ws, topic) {
  signalSocks.get(ws)?.delete(topic)
  const subs = signalTopics.get(topic)
  if (!subs) return
  subs.delete(ws)
  if (subs.size === 0) signalTopics.delete(topic)
}

function sigPublish(topic, payload) {
  const msg = JSON.stringify({ topic, payload })
  const subs = signalTopics.get(topic)
  if (!subs) return
  for (const ws of subs) {
    if (ws.readyState === ws.OPEN) ws.send(msg)
  }
}

signalWss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)) } catch { return }
    if (!msg || typeof msg.topic !== 'string') return
    if (msg.type === 'subscribe')                              sigSubscribe(ws, msg.topic)
    else if (msg.type === 'unsubscribe')                       sigUnsubscribe(ws, msg.topic)
    else if (msg.type === 'publish' && msg.payload !== undefined) sigPublish(msg.topic, msg.payload)
  })
  ws.on('close', () => {
    for (const topic of signalSocks.get(ws) ?? []) sigUnsubscribe(ws, topic)
  })
  ws.on('error', (err) => {
    if (err.code !== 'ECONNRESET') console.error('[signal] ws error:', err.message)
  })
})

const clients = new Set()

wss.on('connection', (ws) => {
  clients.add(ws)
  console.log(`[ws] client connected (total: ${clients.size})`)

  // Send full unit snapshot to newly connected browser
  const snapshot = state.getSnapshot()
  if (Object.keys(snapshot.updated).length > 0) {
    ws.send(JSON.stringify({ type: 'units_delta', data: snapshot }))
  }

  // Send mission/airbases if available
  const mission = state.getMission()
  if (mission) ws.send(JSON.stringify({ type: 'mission', data: mission }))

  const airbases = state.getAirbases()
  if (airbases && typeof airbases === 'object' && Object.keys(airbases).length > 0)
    ws.send(JSON.stringify({ type: 'airbases', data: airbases }))

  const bullseyes = state.getBullseyes()
  if (bullseyes) ws.send(JSON.stringify({ type: 'bullseyes', data: bullseyes }))

  // Status — includes instanceId so clients can detect server restarts
  ws.send(JSON.stringify({ type: 'status', data: { polling: olympus.isPolling(), instanceId: SERVER_INSTANCE_ID } }))

  // Send persisted state files so the browser can hydrate after refresh.
  // If intentionalReset is true (deliberate position change), send defaults
  // and clear the flag so the next connection gets a clean slate.
  const sessionState = stateFiles.read('session')
  if (sessionState.intentionalReset) {
    stateFiles.setIntentionalReset(false)
    ws.send(JSON.stringify({ type: 'state', key: 'atc',     data: stateFiles.DEFAULTS.atc }))
    ws.send(JSON.stringify({ type: 'state', key: 'catcc',   data: stateFiles.DEFAULTS.catcc }))
    ws.send(JSON.stringify({ type: 'state', key: 'session', data: { ...stateFiles.DEFAULTS.session, olympusAddress: sessionState.olympusAddress } }))
  } else {
    ws.send(JSON.stringify({ type: 'state', key: 'atc',     data: stateFiles.read('atc') }))
    ws.send(JSON.stringify({ type: 'state', key: 'catcc',   data: stateFiles.read('catcc') }))
    ws.send(JSON.stringify({ type: 'state', key: 'session', data: sessionState }))
  }

  ws.on('close', () => {
    clients.delete(ws)
    console.log(`[ws] client disconnected (total: ${clients.size})`)
    if (clients.size === 0) {
      stateFiles.patch('session', { clientList: [] })
      console.log('[ws] all clients gone — session clientList cleared')
    }
  })

  ws.on('error', (err) => {
    if (err.code === 'ECONNRESET') return
    console.error('[ws] client error:', err.message)
  })
})

function broadcast(message) {
  const payload = JSON.stringify(message)
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload)
    }
  }
}

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
