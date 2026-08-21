'use strict'

const fs = require('fs')
const path = require('path')

// GET /api/abm/raster/:theatre/:layer(/image.png) — layer is one of
// basemap (.base)/terrain (.terrain)/water (.water)/roads (.roads); see
// buildAbmBasemap.js / client's drawAbmRaster.js. basemap/terrain renamed
// 2026-08-11 (formerly landfill/basemap respectively).
const ABM_RASTER_LAYERS = new Set(['basemap', 'terrain', 'water', 'roads'])

// Registers every REST endpoint onto `app`. `broadcast` comes from the
// app-WS layer (server/src/wsBroadcast.js) so /api/connect can push
// units_delta/mission/airbases/bullseyes/status events to connected clients.
function registerApiRoutes(app, { olympus, state, stateFiles, navdata, elevation, broadcast, getWsClientCount, presetsPath }) {
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

  // GET /api/elevation?lat=&lng= — point terrain elevation (metres MSL) from the
  // same SRTM-backed DB used internally for per-unit AGL (server/src/elevation.js).
  app.get('/api/elevation', (req, res) => {
    const lat = parseFloat(req.query.lat)
    const lng = parseFloat(req.query.lng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'lat/lng required' })
    }
    res.json({ elevationM: elevation.getElevation(lat, lng) })
  })

  // GET /api/airports/polygons/:theatre — airport surface polygon GeoJSON for ASDE-X
  app.get('/api/airports/polygons/:theatre', (req, res) => {
    const { theatre } = req.params
    const folder = navdata.theatreFolder(theatre)
    if (!folder) return res.status(404).json({ error: `unknown theatre: ${theatre}` })
    const filePath = path.join(__dirname, '../../navdata/cache', folder, 'airports_polygons.json')
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'no surface data for this theatre' })
    res.sendFile(filePath)
  })

  // GET /api/abm/raster/:theatre/:layer — baked raster metadata
  app.get('/api/abm/raster/:theatre/:layer', (req, res) => {
    const { theatre, layer } = req.params
    if (!ABM_RASTER_LAYERS.has(layer)) return res.status(404).json({ error: `unknown raster layer: ${layer}` })
    const folder = navdata.theatreFolder(theatre)
    if (!folder) return res.status(404).json({ error: `unknown theatre: ${theatre}` })
    const filePath = path.join(__dirname, '../../navdata/cache', folder, `${layer}.json`)
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'no data for this layer/theatre' })
    res.sendFile(filePath)
  })

  // GET /api/abm/raster/:theatre/:layer/image.png — the raster itself
  app.get('/api/abm/raster/:theatre/:layer/image.png', (req, res) => {
    const { theatre, layer } = req.params
    if (!ABM_RASTER_LAYERS.has(layer)) return res.status(404).json({ error: `unknown raster layer: ${layer}` })
    const folder = navdata.theatreFolder(theatre)
    if (!folder) return res.status(404).json({ error: `unknown theatre: ${theatre}` })
    const filePath = path.join(__dirname, '../../navdata/cache', folder, `${layer}.png`)
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'no data for this layer/theatre' })
    res.sendFile(filePath)
  })

  // GET /api/airports/names/:theatre — reversed name map: { dcsName: stemName }
  app.get('/api/airports/names/:theatre', (req, res) => {
    const { theatre } = req.params
    const mapPath = path.join(__dirname, '../../navdata/config/airport_name_map.json')
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
    const filePath = path.join(__dirname, '../../navdata/config/asdex_colors.json')
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
      wsClients: getWsClientCount(),
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
      if (!fs.existsSync(presetsPath)) return res.json({ slots: Array(12).fill(null) })
      res.json(JSON.parse(fs.readFileSync(presetsPath, 'utf8')))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/presets — persist preset slots to disk
  app.post('/api/presets', (req, res) => {
    try {
      const dir = path.dirname(presetsPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(presetsPath, JSON.stringify(req.body, null, 2))
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // ─── State file API ────────────────────────────────────────────────────────

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
}

module.exports = { registerApiRoutes }
