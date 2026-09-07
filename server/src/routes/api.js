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
function registerApiRoutes(app, { sourceRegistry, srs, tacviewRelayClient, state, stateFiles, navdata, elevation, broadcast, getWsClientCount, presetsPath }) {
  // Races probe() across every registered source type, resolving to whichever
  // answers first — this is what lets Login.jsx's "Source Port" field work
  // without a manual Olympus/Tacview selector (see
  // pluggable-source-architecture-spec.md §5's 2026-09-03 decision). Each
  // source's own probe() is responsible for actually distinguishing itself
  // (e.g. tacview.js's probe waits for Tacview's unsolicited handshake greeting
  // rather than just checking the TCP connection succeeded, since a bare
  // connect would also succeed against Olympus's HTTP port).
  async function autoDetectSourceType(sourceCfg, sourceRegistry) {
    const attempts = sourceRegistry.SOURCE_TYPES.map((type) =>
      sourceRegistry.get(type).probe(sourceCfg).then(
        () => type,
        (err) => { throw Object.assign(err, { sourceType: type }) },
      )
    )
    try {
      return { sourceType: await Promise.any(attempts) }
    } catch (err) {
      // Promise.any's AggregateError swallows each attempt's specific reason
      // by default — log them individually (tagged with which source type,
      // server-side only) so a total failure is diagnosable. If any one of
      // them positively identified its protocol (e.g. Tacview's greeting
      // matched, then it rejected our password), surface that message as-is
      // to the client instead of the generic "nothing answered" one — it's
      // already specific and doesn't need a type tag, since it names its own
      // protocol in the text.
      const errors = err.errors ?? []
      for (const e of errors) console.error(`[autoDetect] ${e.sourceType}: ${e.message}`)
      const identified = errors.find((e) => e.identified)
      return { sourceType: null, error: identified?.message ?? null }
    }
  }

  function stopAllSources(sourceRegistry) {
    for (const type of sourceRegistry.SOURCE_TYPES) {
      const source = sourceRegistry.get(type)
      if (source.isPolling()) source.stop()
    }
    if (tacviewRelayClient.isConnected()) tacviewRelayClient.stop()
  }

  // Rapid repeated /api/connect calls each tear down and rebuild the live
  // Tacview RTT socket via stopAllSources()+start() (a browser relogin,
  // multiple controllers/tabs connecting around the same time, or just
  // re-clicking Connect) — Tacview's own RTT server can't tolerate that
  // churn and corrupts its internal state, crashing tacview.dll with an
  // ACCESS_VIOLATION on DCS's next export tick (confirmed live twice now,
  // 2026-09-06: dcs.20260906-202834.crash and dcs.log-20260906-211347 — the
  // latter shows three full /api/connect cycles ~3-4s apart, each restarting
  // the connection from scratch, the third crashing mid-handshake of the
  // second). The in-request double-probe within a single /api/connect was
  // already fixed (the comment below this covers that); this is the
  // remaining gap between *separate* requests. 5s comfortably covers the
  // observed 3-4s cadence with margin, without being so long it blocks a
  // genuine "fix my password, try again" retry.
  let lastTacviewConnectAt = 0
  const TACVIEW_RECONNECT_COOLDOWN_MS = 5000
  function tacviewReconnectTooSoon() {
    return Date.now() - lastTacviewConnectAt < TACVIEW_RECONNECT_COOLDOWN_MS
  }

  // POST /api/connect — start a primary data source with supplied credentials.
  // See resources/specs/data-sources/pluggable-source-architecture-spec.md
  // (registry/dispatch) and custom-datasource-tacview-spec.md §0.1 (the two
  // Tacview connection modes this now dispatches between).
  app.post('/api/connect', async (req, res) => {
    const { sourceType: requestedSourceType, relayUrl, ...sourceCfg } = req.body ?? {}

    // SRS relay — best-effort and optional, never probed and never blocks/fails
    // this request. A truthy relayUrl (re)starts the relay-client; an empty one
    // is treated as "no opinion" and leaves whatever's already running alone,
    // so a server-side default (TRACS_RELAY_URL) isn't silently undone by a
    // browser that never filled in the field.
    // Skip restarting when already connected with this exact relayUrl+password —
    // otherwise every login to a shared backend (any number of browsers can be
    // logged into one) would tear down and rebuild a perfectly working relay
    // connection for no reason, same class of check olympus.js's
    // alreadyOnSameSource does below.
    // See resources/specs/data-sources/tracs-relay-architecture-spec.md.
    // relayPassword is only ever distinct from `password` in Tacview-Direct
    // mode with a relay also configured (Tacview's RTT password is flat, not
    // coalition-scoped, so it can't double as the relay's per-coalition
    // secret there) -- every other source mode leaves relayPassword unset
    // client-side, falling back to `password` here. See
    // resources/specs/data-sources/pluggable-source-architecture-spec.md §7.
    const relayConfig = srs.getConfig()
    const relayAuthPassword = sourceCfg.relayPassword || sourceCfg.password
    const alreadyOnSameRelay = srs.isConnected()
      && relayConfig?.relayUrl === relayUrl
      && relayConfig?.password === relayAuthPassword
      && relayConfig?.coalition === sourceCfg.coalition
    if (relayUrl && !alreadyOnSameRelay) {
      srs.start(
        { relayUrl, password: relayAuthPassword, coalition: sourceCfg.coalition },
        { onUnitsDelta: (delta) => broadcast({ type: 'units_delta', data: delta }) },
      )
    }

    // Fast path for the overwhelmingly common case a plain relogin/refresh
    // hits: the exact same primary source, same config, already live. Short-
    // circuits BEFORE autoDetectSourceType's probe race below (which itself
    // briefly connects to Tacview's RTT port) — not just before the restart
    // further down — since re-probing a source that's already known-good is
    // exactly the kind of unnecessary churn that contributed to the crashes
    // documented on tacviewReconnectTooSoon() above. Only applies to the
    // direct-source path (a truthy olympusUrl rules out usingRelayAsPrimary,
    // which has its own identical alreadyOnSameTvRelay check just above).
    if (sourceCfg.olympusUrl) {
      const currentType = state.getSourceType()
      const current = currentType ? sourceRegistry.get(currentType) : null
      const alreadyLiveOnSameConfig = current
        && (!requestedSourceType || requestedSourceType === currentType)
        && current.isPolling()
        && current.getConfig()?.olympusUrl === sourceCfg.olympusUrl
      if (alreadyLiveOnSameConfig) {
        broadcast({ type: 'status', data: { polling: true, sourceType: currentType } })
        return res.json({ ok: true })
      }
    }

    // Relay-hosted Tacview as the PRIMARY source — "Relay Port filled, Source
    // Port blank" (the dispatch slot custom-datasource-tacview-spec.md §0.1
    // and dataminer-architecture-placeholder-spec.md §4 reserved for this,
    // shared with a future dataminer — a relay only ever runs one occupant of
    // this slot). Distinct from the SRS-relay block above, which always runs
    // whenever relayUrl is set, regardless of which primary source is active.
    const usingRelayAsPrimary = Boolean(relayUrl) && !sourceCfg.olympusUrl
    if (usingRelayAsPrimary) {
      const tvConfig = tacviewRelayClient.getConfig()
      const alreadyOnSameTvRelay = tacviewRelayClient.isConnected()
        && tvConfig?.relayUrl === relayUrl
        && tvConfig?.password === sourceCfg.password
        && tvConfig?.coalition === (sourceCfg.coalition ?? 'blue')
      if (!alreadyOnSameTvRelay) {
        if (tacviewReconnectTooSoon()) {
          return res.status(429).json({ error: 'Reconnected to Tacview too recently — wait a few seconds before trying again (rapid reconnects can crash Tacview’s DCS export)' })
        }
        // start() itself is fire-and-forget and never used to be checked here
        // at all -- a wrong coalition/password used to return {ok:true}
        // regardless, since nothing awaited whether the connection actually
        // authenticated. probe() (a separate, throwaway connection, same
        // pattern tacview.js's direct-mode probe already uses) catches that
        // before committing to a live connection.
        try {
          await tacviewRelayClient.probe({ relayUrl, password: sourceCfg.password ?? '', coalition: sourceCfg.coalition ?? 'blue' })
        } catch (err) {
          return res.status(502).json({ error: err.identified ? err.message : 'Cannot reach the relay for Tacview data — check the Relay Port and coalition password' })
        }
        lastTacviewConnectAt = Date.now()
        stopAllSources(sourceRegistry)
        state.setSourceType('tacview')
        tacviewRelayClient.start(
          { relayUrl, password: sourceCfg.password ?? '', coalition: sourceCfg.coalition ?? 'blue' },
          {
            onUnitsDelta: (delta) => broadcast({ type: 'units_delta', data: delta }),
            onMission:    (data)  => broadcast({ type: 'mission',    data }),
            onBullseyes:  (data)  => broadcast({ type: 'bullseyes', data }),
          }
        )
        broadcast({ type: 'units_clear' })
      }
      broadcast({ type: 'status', data: { polling: true, sourceType: 'tacview' } })
      return res.json({ ok: true })
    }

    if (!sourceCfg.olympusUrl) {
      return res.status(400).json({ error: 'olympusUrl is required' })
    }
    sourceCfg.password   = sourceCfg.password   ?? ''
    sourceCfg.coalition  = sourceCfg.coalition  ?? 'blue'

    let sourceType = requestedSourceType
    let alreadyProbed = false
    if (!sourceType) {
      const detected = await autoDetectSourceType(sourceCfg, sourceRegistry)
      sourceType = detected.sourceType
      alreadyProbed = true
      if (!sourceType) {
        return res.status(502).json({ error: detected.error ?? 'Cannot reach any known source type at that address' })
      }
    }

    const source = sourceRegistry.get(sourceType)
    if (!source) {
      return res.status(400).json({ error: `unknown sourceType: ${sourceType}` })
    }

    // Skip probe + restart only when already polling the same source with the
    // same config — a simultaneous probe to the same server triggers a 426
    // from Olympus. A different config is a reconnect, so probe and restart.
    const alreadyOnSameSource = state.getSourceType() === sourceType
      && source.isPolling()
      && source.getConfig()?.olympusUrl === sourceCfg.olympusUrl
    if (!alreadyOnSameSource) {
      // autoDetectSourceType() above already completed a full probe cycle for
      // `sourceType` moments ago (that's how it was identified) — re-probing
      // here would be a second connect/handshake/disconnect round-trip against
      // the same server in near-zero elapsed time. Harmless against Olympus,
      // but observed live (2026-09-06 crash log) to land two back-to-back
      // Tacview RTT connections close enough together to crash tacview.dll
      // with an ACCESS_VIOLATION on its next export tick — so only probe here
      // when `sourceType` was client-specified and genuinely never probed yet.
      if (sourceType === 'tacview' && tacviewReconnectTooSoon()) {
        return res.status(429).json({ error: 'Reconnected to Tacview too recently — wait a few seconds before trying again (rapid reconnects can crash Tacview’s DCS export)' })
      }

      if (!alreadyProbed) {
        try {
          await source.probe(sourceCfg)
        } catch (err) {
          return res.status(502).json({ error: `Cannot reach ${sourceType} source: ${err.message}` })
        }
      }

      // Mutual exclusivity — stop every other source (including relay-hosted
      // Tacview, if that was active) before starting this one.
      stopAllSources(sourceRegistry)

      if (sourceType === 'tacview') lastTacviewConnectAt = Date.now()
      state.setSourceType(sourceType)
      source.start(
        sourceCfg,
        {
          onUnitsDelta:   (delta) => broadcast({ type: 'units_delta', data: delta }),
          onMission:      (data)  => broadcast({ type: 'mission',    data }),
          onAirbases:     (data)  => broadcast({ type: 'airbases',  data }),
          onBullseyes:    (data)  => broadcast({ type: 'bullseyes', data }),
          onDisconnect:   ()      => broadcast({ type: 'status', data: { polling: false, reason: `${sourceType}_unreachable` } }),
        }
      )
      broadcast({ type: 'units_clear' })
    }

    // Notify all currently-connected WS clients that polling has started (or is
    // already running). This covers new browser windows joining an active session.
    broadcast({ type: 'status', data: { polling: true, sourceType } })

    res.json({ ok: true })
  })

  // POST /api/tacview/theatre-override — Login.jsx's Theatre control
  // (Tacview-only; see custom-datasource-tacview-spec.md §4.2 for why
  // auto-detection alone can't always be trusted, e.g. the unbreakable
  // MarianaIslands/MarianaIslandsWWII bbox tie). Dispatches to whichever
  // Tacview connection mode is actually active — direct (sourceRegistry) or
  // relay-hosted-primary (tacviewRelayClient) — same distinction /api/connect
  // itself has to make.
  app.post('/api/tacview/theatre-override', (req, res) => {
    const { theatre } = req.body ?? {}
    if (!theatre) return res.status(400).json({ error: 'theatre is required' })
    const tacview = sourceRegistry.get('tacview')
    if (tacviewRelayClient.isConnected()) {
      tacviewRelayClient.overrideTheatre(theatre)
    } else if (tacview.isPolling()) {
      tacview.overrideTheatre(theatre)
    } else {
      return res.status(409).json({ error: 'no active Tacview source to override' })
    }
    res.json({ ok: true })
  })

  // POST /api/tacview/theatre-reset — undo a theatre override (or a bad
  // initial auto-vote) and re-run detection over a fresh window, without
  // touching the live Tacview connection (a browser relogin alone can't do
  // this — see /api/connect's alreadyOnSameSource skip above).
  app.post('/api/tacview/theatre-reset', (req, res) => {
    const tacview = sourceRegistry.get('tacview')
    if (tacviewRelayClient.isConnected()) {
      tacviewRelayClient.resetTheatreDetection()
    } else if (tacview.isPolling()) {
      tacview.resetTheatreDetection()
    } else {
      return res.status(409).json({ error: 'no active Tacview source to reset' })
    }
    res.json({ ok: true })
  })

  // GET /api/debug/units — live unit snapshot (dev/debug)
  app.get('/api/debug/units', (req, res) => {
    const { updated } = state.getSnapshot()
    res.json(updated)
  })

  // GET /api/navdata/* — Navigraph navdata endpoints
  app.get('/api/navdata/status',      navdata.handleStatus)
  app.get('/api/navdata/theatres',    navdata.handleTheatres)
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
    const sourceType = state.getSourceType()
    const polling = (sourceRegistry.get(sourceType)?.isPolling() ?? false) || tacviewRelayClient.isConnected()
    res.json({ polling, sourceType })
  })

  // GET /api/debug — inspect current in-memory state (dev only)
  app.get('/api/debug', (req, res) => {
    const snapshot = state.getSnapshot()
    const unitList = Object.values(snapshot.updated)
    res.json({
      polling: (sourceRegistry.get(state.getSourceType())?.isPolling() ?? false) || tacviewRelayClient.isConnected(),
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
