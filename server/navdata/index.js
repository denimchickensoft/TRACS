'use strict'

const fs         = require('fs')
const path       = require('path')
const { buildCache, CACHE_DIR, BUNDLED_CACHE_DIR, CONFIG_DIR, COLOR_CONFIG_DIR } = require('./parser')
const { runExtract, validateLnmDb } = require('./tools/extract-navdata')
const stateFiles = require('../src/stateFiles')

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

// Fixed per-terrain offset from DCS's own INTERNAL Zulu clock to theatre-local
// time — mirrors client/src/utils/theatreTime.js's THEATRE_UTC_OFFSETS
// (same values, kept in sync by hand). This is what toUtcDateTime() uses to
// recover DCS-internal Zulu from a theatre-local dateAndTime reading — valid
// for Olympus's dateAndTime (already expressed in DCS's own internal clock)
// and, downstream, for Tacview's synthesized dateAndTime too, ONCE it's
// already in theatre-local form. Do NOT use this to convert Tacview's raw
// ReferenceTime into local — that's a different, real-world-anchored clock;
// see theatreTacviewRealUtcOffset() for that leg.
function theatreUtcOffset(theatre) {
  return loadTheatres()[theatre]?.utcOffset ?? 0
}

// Fixed per-terrain offset from REAL-WORLD UTC (Tacview's `ReferenceTime`,
// confirmed live to be true calendar UTC, e.g. "2011-06-25T09:30:01Z") to
// theatre-local time — a genuinely different constant from theatreUtcOffset()
// above, found via a live DCS-clock-vs-Tacview cross-check on
// PersianGulf (real UTC → local needed +3.5, not the existing table's +4,
// which is correct only for the separate DCS-internal-Zulu → local leg).
// DCS's own internal mission clock is evidently skewed from real-world UTC by
// its own fixed amount, independent of the terrain's local-time offset — a
// real, non-obvious quirk, not a bug in either constant. Only PersianGulf has
// been empirically verified; every other theatre falls back to its regular
// utcOffset, which is an unverified assumption (the two constants happening
// to match), not a confirmed value — expect other theatres to need their own
// real correction once live-tested with Tacview.
function theatreTacviewRealUtcOffset(theatre) {
  const cfg = loadTheatres()[theatre]
  return cfg?.tacviewRealUtcOffset ?? cfg?.utcOffset ?? 0
}

// bbox format [minLon, minLat, maxLon, maxLat], same convention as
// extract-navdata.js's inBbox and the other build scripts that duplicate it.
// Returns every theatre whose bbox contains the point — usually one, more in
// an overlap zone (Syria/Sinai/Iraq, PersianGulf/Iraq/Afghanistan). Used by
// tacview.js's majority-vote theatre detection.
function theatresContaining(lat, lng) {
  const names = []
  for (const [name, cfg] of Object.entries(loadTheatres())) {
    const [minLon, minLat, maxLon, maxLat] = cfg.bbox ?? []
    if (lng >= minLon && lng <= maxLon && lat >= minLat && lat <= maxLat) names.push(name)
  }
  return names
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

function refreshReady() {
  const mp = path.join(CACHE_DIR, 'manifest.json')
  if (fs.existsSync(mp)) {
    _manifest = JSON.parse(fs.readFileSync(mp, 'utf8'))
    _ready    = true
    console.log(`[navdata] ready - built ${_manifest.builtAt}`)
  } else {
    _manifest = null
    _ready    = false
    console.log('[navdata] no LNM cache - fixes/navaids/airways/procedures/etc. will return 503 until an LNM database is configured')
  }
}

// Dev-environment override, mirroring the TRACS_STATE_DIR/PORT pattern in
// stateFiles.js/index.js — lets a developer running the plain Node server
// (no Electron, no native file picker available) point at their own LNM
// sqlite via a shell var or .env file with no UI involved. Authoritative
// when set: persisted into the same stateFiles key the Electron picker and
// the (now-removed) manual Settings text field both write to, so the rest of
// the pipeline (buildCache's change-detection, extraction, manifest, GET
// status) behaves identically regardless of which path set it.
function applyLnmDbPathEnvOverride() {
  const envPath = process.env.LNM_DB_PATH
  if (!envPath) return
  const current = stateFiles.read('navdata').lnmDbPath
  if (current !== envPath) {
    stateFiles.patch('navdata', { lnmDbPath: envPath })
  }
}

async function init() {
  try {
    applyLnmDbPathEnvOverride()
    await buildCache()
    refreshReady()
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
    res.set('Cache-Control', 'no-store')
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

// GET /api/navdata/theatres — every known theatre name, for the manual
// theatre-override control (Login.jsx). Needed regardless of which primary
// source is active: Tacview has no reliable auto-detected theatre signal
// beyond a bbox majority vote, and that vote can never disambiguate MarianaIslands/MarianaIslandsWWII, whose
// bboxes are identical.
function handleTheatres(req, res) {
  res.json({ theatres: Object.keys(loadTheatres()) })
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
    data.palettes = JSON.parse(fs.readFileSync(path.join(COLOR_CONFIG_DIR, 'airspace_colors.json'), 'utf8'))
    res.set('Cache-Control', 'no-store')
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
  const { theatre } = req.query
  if (!theatre) return res.status(400).json({ error: 'theatre is required' })
  const folder = theatreFolder(theatre)
  if (!folder) return res.status(404).json({ error: `unknown theatre: ${theatre}` })
  const fp = path.join(BUNDLED_CACHE_DIR, folder, 'relief.json')
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'relief data not built' })
  serveJson(res, fp)
}

function handlePalettes(req, res) {
  try {
    serveJson(res, path.join(COLOR_CONFIG_DIR, 'airspace_colors.json'))
  } catch (err) { res.status(500).json({ error: err.message }) }
}

function handleGeo(req, res) {
  const { theatre } = req.query
  if (!theatre) return res.status(400).json({ error: 'theatre is required' })
  const folder = theatreFolder(theatre)
  if (!folder) return res.status(404).json({ error: `unknown theatre: ${theatre}` })
  const fp = path.join(BUNDLED_CACHE_DIR, folder, 'geo.json')
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'geo data not built' })
  serveJson(res, fp)
}

// MVA is facility-scoped (per ICAO, ~50 NM radius), served like procedures —
// search every theatre folder for cache/<folder>/mva/<ICAO>.json.
function handleMva(req, res) {
  const { icao } = req.query
  if (!icao) return res.status(400).json({ error: 'icao is required' })
  for (const [, tConf] of Object.entries(loadTheatres())) {
    const fp = path.join(BUNDLED_CACHE_DIR, tConf.folder, 'mva', `${icao.toUpperCase()}.json`)
    if (fs.existsSync(fp)) return serveJson(res, fp)
  }
  res.status(404).json({ error: `no MVA data for ${icao}` })
}

// GET /api/navdata/lnm-config — current LNM database path + readiness, for
// the setup dialog, the Settings panel and NO NAVDATA command replies.
function handleLnmConfig(req, res) {
  const { lnmDbPath } = stateFiles.read('navdata')
  res.json({ lnmDbPath, ready: _ready, builtAt: _manifest?.builtAt ?? null })
}

// POST /api/navdata/lnm-config { lnmDbPath } — validate, persist, and
// extract immediately so the running server doesn't need a restart. Each
// user points this at their own legally-obtained LittleNavMap/Navigraph
// database; TRACS never bundles or redistributes this data itself (it's
// licensed per user).
async function handleSetLnmConfig(req, res) {
  const { lnmDbPath } = req.body ?? {}
  if (!lnmDbPath || typeof lnmDbPath !== 'string') {
    return res.status(400).json({ error: 'lnmDbPath is required' })
  }
  try {
    await validateLnmDb(lnmDbPath)
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }
  try {
    stateFiles.write('navdata', { lnmDbPath })
    await runExtract(lnmDbPath)
    refreshReady()
    res.json({ ok: true, ready: _ready, builtAt: _manifest?.builtAt ?? null })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

module.exports = {
  init,
  CACHE_DIR,
  BUNDLED_CACHE_DIR,
  COLOR_CONFIG_DIR,
  theatreFolder,
  theatreUtcOffset,
  theatreTacviewRealUtcOffset,
  theatresContaining,
  handleTheatres,
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
  handleLnmConfig,
  handleSetLnmConfig,
}
