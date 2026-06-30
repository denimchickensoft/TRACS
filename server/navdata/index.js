'use strict'

const fs   = require('fs')
const path = require('path')
const { buildCache, CACHE_DIR, CONFIG_DIR } = require('./parser')

let _ready    = false
let _manifest = null
let _theatres = null

function loadTheatres() {
  if (_theatres) return _theatres
  _theatres = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'theatres.json'), 'utf8'))
  return _theatres
}

function theatreFolder(theatre) {
  return loadTheatres()[theatre]?.folder ?? null
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

async function init() {
  try {
    await buildCache()
    const mp = path.join(CACHE_DIR, 'manifest.json')
    if (fs.existsSync(mp)) {
      _manifest = JSON.parse(fs.readFileSync(mp, 'utf8'))
      _ready    = true
      console.log(`[navdata] ready — built ${_manifest.builtAt}`)
    } else {
      console.log('[navdata] no cache — endpoints will return 503')
    }
  } catch (err) {
    console.error('[navdata] init failed:', err.message)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function notReady(res) {
  return res.status(503).json({ status: 'building' })
}

function serveJson(res, filePath) {
  try {
    res.json(JSON.parse(fs.readFileSync(filePath, 'utf8')))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

// ── HTTP handlers ─────────────────────────────────────────────────────────────

function handleStatus(req, res) {
  res.json({
    ready:   _ready,
    builtAt: _manifest?.builtAt ?? null,
  })
}

function handleAirspace(req, res) {
  if (!_ready) return notReady(res)
  const { theatre } = req.query
  if (!theatre) return res.status(400).json({ error: 'theatre is required' })
  const folder = theatreFolder(theatre)
  if (!folder) return res.status(404).json({ error: `unknown theatre: ${theatre}` })
  const fp = path.join(CACHE_DIR, folder, 'airspace.json')
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'airspace data not built' })
  try {
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'))
    data.palettes = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'airspace_colors.json'), 'utf8'))
    res.json(data)
  } catch (err) { res.status(500).json({ error: err.message }) }
}

function handleFixes(req, res) {
  if (!_ready) return notReady(res)
  const { theatre } = req.query
  if (!theatre) return res.status(400).json({ error: 'theatre is required' })
  const folder = theatreFolder(theatre)
  if (!folder) return res.status(404).json({ error: `unknown theatre: ${theatre}` })
  const fp = path.join(CACHE_DIR, folder, 'fixes.json')
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'fix data not built' })
  serveJson(res, fp)
}

function handleNavaids(req, res) {
  if (!_ready) return notReady(res)
  const { theatre } = req.query
  if (!theatre) return res.status(400).json({ error: 'theatre is required' })
  const folder = theatreFolder(theatre)
  if (!folder) return res.status(404).json({ error: `unknown theatre: ${theatre}` })
  const fp = path.join(CACHE_DIR, folder, 'navaids.json')
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'navaid data not built' })
  serveJson(res, fp)
}

function handleProcedures(req, res) {
  if (!_ready) return notReady(res)
  const { icao } = req.query
  if (!icao) return res.status(400).json({ error: 'icao is required' })
  for (const [, tConf] of Object.entries(loadTheatres())) {
    const fp = path.join(CACHE_DIR, tConf.folder, 'procedures', `${icao.toUpperCase()}.json`)
    if (fs.existsSync(fp)) return serveJson(res, fp)
  }
  res.status(404).json({ error: `no procedure data for ${icao}` })
}

function handleFrequencies(req, res) {
  if (!_ready) return notReady(res)
  const { icao, role } = req.query
  if (!icao || !role) return res.status(400).json({ error: 'icao and role are required' })
  const fp = path.join(CACHE_DIR, 'sectors.json')
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'sector data not built' })
  try {
    const sectors = JSON.parse(fs.readFileSync(fp, 'utf8'))
    const entry   = sectors[icao.toUpperCase()]
    if (!entry) return res.json({ freqs: [] })
    const freqs = entry.freqs?.[role.toLowerCase()] ?? []
    res.json({ name: entry.name, freqs })
  } catch (err) { res.status(500).json({ error: err.message }) }
}

function handleCtrFacilities(req, res) {
  if (!_ready) return notReady(res)
  const { theatre } = req.query
  if (!theatre) return res.status(400).json({ error: 'theatre is required' })
  const folder = theatreFolder(theatre)
  if (!folder) return res.status(404).json({ error: `unknown theatre: ${theatre}` })
  const fp = path.join(CACHE_DIR, folder, 'ctrs.json')
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'CTR data not built' })
  serveJson(res, fp)
}

function handleSector(req, res) {
  if (!_ready) return notReady(res)
  const { icao } = req.query
  if (!icao) return res.status(400).json({ error: 'icao is required' })
  const fp = path.join(CACHE_DIR, 'sectors.json')
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'sector data not built' })
  try {
    const sectors = JSON.parse(fs.readFileSync(fp, 'utf8'))
    const entry   = sectors[icao.toUpperCase()]
    if (!entry) return res.status(404).json({ error: `no sector data for ${icao}` })
    res.json(entry)
  } catch (err) { res.status(500).json({ error: err.message }) }
}

function handleHoldings(req, res) {
  if (!_ready) return notReady(res)
  const { theatre } = req.query
  if (!theatre) return res.status(400).json({ error: 'theatre is required' })
  const folder = theatreFolder(theatre)
  if (!folder) return res.status(404).json({ error: `unknown theatre: ${theatre}` })
  const fp = path.join(CACHE_DIR, folder, 'holdings.json')
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'holdings data not built' })
  serveJson(res, fp)
}

function handleAirways(req, res) {
  if (!_ready) return notReady(res)
  const { theatre } = req.query
  if (!theatre) return res.status(400).json({ error: 'theatre is required' })
  const folder = theatreFolder(theatre)
  if (!folder) return res.status(404).json({ error: `unknown theatre: ${theatre}` })
  const fp = path.join(CACHE_DIR, folder, 'airways.json')
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'airways data not built' })
  serveJson(res, fp)
}

function handleMsa(req, res) {
  if (!_ready) return notReady(res)
  const { theatre } = req.query
  if (!theatre) return res.status(400).json({ error: 'theatre is required' })
  const folder = theatreFolder(theatre)
  if (!folder) return res.status(404).json({ error: `unknown theatre: ${theatre}` })
  const fp = path.join(CACHE_DIR, folder, 'msa.json')
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'MSA data not built' })
  serveJson(res, fp)
}

function handleMora(req, res) {
  if (!_ready) return notReady(res)
  const { theatre } = req.query
  if (!theatre) return res.status(400).json({ error: 'theatre is required' })
  const folder = theatreFolder(theatre)
  if (!folder) return res.status(404).json({ error: `unknown theatre: ${theatre}` })
  const fp = path.join(CACHE_DIR, folder, 'mora.json')
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'MORA data not built' })
  serveJson(res, fp)
}

function handleRelief(req, res) {
  if (!_ready) return notReady(res)
  const { theatre } = req.query
  if (!theatre) return res.status(400).json({ error: 'theatre is required' })
  const folder = theatreFolder(theatre)
  if (!folder) return res.status(404).json({ error: `unknown theatre: ${theatre}` })
  const fp = path.join(CACHE_DIR, folder, 'relief.json')
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'relief data not built' })
  serveJson(res, fp)
}

function handlePalettes(req, res) {
  try {
    serveJson(res, path.join(CONFIG_DIR, 'airspace_colors.json'))
  } catch (err) { res.status(500).json({ error: err.message }) }
}

function handleGeo(req, res) {
  if (!_ready) return notReady(res)
  const { theatre } = req.query
  if (!theatre) return res.status(400).json({ error: 'theatre is required' })
  const folder = theatreFolder(theatre)
  if (!folder) return res.status(404).json({ error: `unknown theatre: ${theatre}` })
  const fp = path.join(CACHE_DIR, folder, 'geo.json')
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'geo data not built' })
  serveJson(res, fp)
}

// MVA is facility-scoped (per ICAO, ~50 NM radius), served like procedures —
// search every theatre folder for cache/<folder>/mva/<ICAO>.json.
function handleMva(req, res) {
  if (!_ready) return notReady(res)
  const { icao } = req.query
  if (!icao) return res.status(400).json({ error: 'icao is required' })
  for (const [, tConf] of Object.entries(loadTheatres())) {
    const fp = path.join(CACHE_DIR, tConf.folder, 'mva', `${icao.toUpperCase()}.json`)
    if (fs.existsSync(fp)) return serveJson(res, fp)
  }
  res.status(404).json({ error: `no MVA data for ${icao}` })
}

module.exports = {
  init,
  theatreFolder,
  handleStatus,
  handleAirspace,
  handleFixes,
  handleNavaids,
  handleProcedures,
  handleFrequencies,
  handleCtrFacilities,
  handleSector,
  handleHoldings,
  handleAirways,
  handleMsa,
  handleMora,
  handleRelief,
  handleMva,
  handleGeo,
  handlePalettes,
}
