'use strict'

const http = require('http')
const path = require('path')
const express = require('express')
const { WebSocketServer } = require('ws')
const olympus = require('./olympus')
const state   = require('./state')
const maps    = require('./maps')

const fs = require('fs')

const PORT = process.env.PORT ?? 3000
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

  try {
    await olympus.probe({ olympusUrl, password: password ?? '' })
  } catch (err) {
    return res.status(502).json({ error: `Cannot reach Olympus: ${err.message}` })
  }

  olympus.start(
    { olympusUrl, password: password ?? '', coalition: coalition ?? 'blue' },
    {
      onUnitsDelta:   (delta) => broadcast({ type: 'units_delta', data: delta }),
      onMission:      (data)  => broadcast({ type: 'mission',     data }),
      onAirbases:     (data)  => broadcast({ type: 'airbases',    data }),
      onDisconnect:   ()      => broadcast({ type: 'status', data: { polling: false, reason: 'olympus_unreachable' } }),
    }
  )

  // Notify all currently-connected WS clients that polling has started.
  // This covers the case where the browser's WS was already open and
  // wsClient.connect() returned early without receiving a status message.
  broadcast({ type: 'status', data: { polling: true } })

  res.json({ ok: true })
})

// GET /api/airbases?theatre=Caucasus — static runway/airbase database
app.get('/api/airbases', (req, res) => {
  const { theatre } = req.query
  if (!theatre) return res.status(400).json({ error: 'theatre is required' })

  // Theatre name → filename mapping (mirrors theatre_index.json convention)
  const FILE_MAP = {
    Caucasus: 'caucasus', Nevada: 'nevada', PersianGulf: 'persiangulf',
    Syria: 'syria', MarianaIslands: 'marianas', SouthAtlantic: 'falklands',
    Sinai: 'sinaimap', Kola: 'kola', Afghanistan: 'afghanistan', Germany: 'germany',
  }
  const file = FILE_MAP[theatre]
  if (!file) return res.status(404).json({ error: `no airbase data for theatre: ${theatre}` })

  const filePath = path.join(__dirname, '../../server/maps/airbases', `${file}.json`)
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'airbase file not found' })

  try {
    res.json(JSON.parse(fs.readFileSync(filePath, 'utf8')))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
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

// Fallback: serve index.html for SPA routes (production only)
app.get('*', (req, res) => {
  res.sendFile(path.join(CLIENT_DIST, 'index.html'))
})

// ─── HTTP + WS server ────────────────────────────────────────────────────────

const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

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

  // Status
  ws.send(JSON.stringify({ type: 'status', data: { polling: olympus.isPolling() } }))

  ws.on('close', () => {
    clients.delete(ws)
    console.log(`[ws] client disconnected (total: ${clients.size})`)
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

server.listen(PORT, () => {
  console.log(`TRACS server running on http://localhost:${PORT}`)
})
