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
  const t = loadTheatres()
  return t[theatre]?.folder ?? null
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

async function init() {
  try {
    await buildCache()
    const mp = path.join(CACHE_DIR, 'manifest.json')
    if (fs.existsSync(mp)) {
      _manifest = JSON.parse(fs.readFileSync(mp, 'utf8'))
      _ready    = true
      console.log(`[navdata] ready — cycle ${_manifest.cycle}, built ${_manifest.builtAt}`)
    } else {
      console.log('[navdata] no source data — endpoints will return 503')
    }
  } catch (err) {
    console.error('[navdata] init failed:', err.message)
  }
}

// ── HTTP handlers ─────────────────────────────────────────────────────────────

function notReady(res) {
  return res.status(503).json({ status: 'building' })
}

function handleStatus(req, res) {
  res.json({
    ready:   _ready,
    cycle:   _manifest?.cycle   ?? null,
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
  try { res.json(JSON.parse(fs.readFileSync(fp, 'utf8'))) } catch (err) { res.status(500).json({ error: err.message }) }
}

function handleNavaids(req, res) {
  if (!_ready) return notReady(res)
  const { theatre } = req.query
  if (!theatre) return res.status(400).json({ error: 'theatre is required' })
  const folder = theatreFolder(theatre)
  if (!folder) return res.status(404).json({ error: `unknown theatre: ${theatre}` })
  const fp = path.join(CACHE_DIR, folder, 'navaids.json')
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'navaid data not built' })
  try { res.json(JSON.parse(fs.readFileSync(fp, 'utf8'))) } catch (err) { res.status(500).json({ error: err.message }) }
}

function handleProcedures(req, res) {
  if (!_ready) return notReady(res)
  const { icao } = req.query
  if (!icao) return res.status(400).json({ error: 'icao is required' })
  // Phase 5: procedure data not yet built — search all theatre folders
  for (const [, tConf] of Object.entries(loadTheatres())) {
    const fp = path.join(CACHE_DIR, tConf.folder, 'procedures', `${icao.toUpperCase()}.json`)
    if (fs.existsSync(fp)) {
      try { return res.json(JSON.parse(fs.readFileSync(fp, 'utf8'))) } catch (err) { return res.status(500).json({ error: err.message }) }
    }
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
    const key     = `${icao.toUpperCase()}:${role.toLowerCase()}`
    const entry   = sectors[key]
    if (!entry) return res.json({ freqs: [] })
    const { name, freqs, class: cls, transitionAlt } = entry
    res.json({ name, freqs, class: cls, transitionAlt })
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
  try { res.json(JSON.parse(fs.readFileSync(fp, 'utf8'))) } catch (err) { res.status(500).json({ error: err.message }) }
}

function handleSector(req, res) {
  if (!_ready) return notReady(res)
  const { icao, role } = req.query
  if (!icao || !role) return res.status(400).json({ error: 'icao and role are required' })
  const fp = path.join(CACHE_DIR, 'sectors.json')
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'sector data not built' })
  try {
    const sectors = JSON.parse(fs.readFileSync(fp, 'utf8'))
    const key     = `${icao.toUpperCase()}:${role.toLowerCase()}`
    const entry   = sectors[key]
    if (!entry) return res.status(404).json({ error: `no sector data for ${icao}/${role}` })
    res.json(entry)
  } catch (err) { res.status(500).json({ error: err.message }) }
}

module.exports = {
  init,
  handleStatus,
  handleAirspace,
  handleFixes,
  handleNavaids,
  handleProcedures,
  handleFrequencies,
  handleCtrFacilities,
  handleSector,
}
