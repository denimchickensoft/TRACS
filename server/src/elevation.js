'use strict'

const path = require('path')
const DB_PATH = path.join(__dirname, '../data/elevation.db')

let db          = null
let tileCache   = new Map()   // "lat0,lon0" → Buffer | null
let pointCache  = new Map()   // "lat100,lon100" → number | null

// LRU caps (Map iteration order is insertion order, so a hit is re-inserted
// at the end and the first key is the least recently used). A tile is
// ~20 KB; a long session over a large theatre would otherwise keep every
// tile and millions of points it ever touched.
const MAX_TILES  = 1024
const MAX_POINTS = 200_000

function cacheGet(cache, key) {
  const value = cache.get(key)
  cache.delete(key)
  cache.set(key, value)
  return value
}

function cacheSet(cache, key, value, max) {
  cache.set(key, value)
  if (cache.size > max) cache.delete(cache.keys().next().value)
}

function init() {
  try {
    const Database = require('better-sqlite3')
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
    console.log('[elevation] database ready')
  } catch {
    console.warn('[elevation] no elevation database - AGL unavailable (run scripts/buildElevationDb.js)')
  }
}

function getTile(lat0, lon0) {
  const key = `${lat0},${lon0}`
  if (tileCache.has(key)) return cacheGet(tileCache, key)
  if (!db) { cacheSet(tileCache, key, null, MAX_TILES); return null }

  const row  = db.prepare('SELECT data FROM elevation_tiles WHERE lat0 = ? AND lon0 = ?').get(lat0, lon0)
  const tile = row ? Buffer.from(row.data) : null
  cacheSet(tileCache, key, tile, MAX_TILES)
  return tile
}

// Returns terrain elevation in metres MSL, or null if unavailable.
function getElevation(lat, lon) {
  const lat100 = Math.round(lat * 100)
  const lon100 = Math.round(lon * 100)
  const ck     = `${lat100},${lon100}`
  if (pointCache.has(ck)) return cacheGet(pointCache, ck)

  const lat0 = Math.floor(lat)
  const lon0 = Math.floor(lon)
  const tile = getTile(lat0, lon0)

  if (!tile) { cacheSet(pointCache, ck, null, MAX_POINTS); return null }

  const row  = Math.min(100, Math.max(0, Math.round((lat0 + 1 - lat) * 100)))
  const col  = Math.min(100, Math.max(0, Math.round((lon - lon0)     * 100)))
  const idx  = row * 101 + col
  const raw  = tile.readInt16BE(idx * 2)
  const elev = raw <= 0 ? 0 : raw   // ocean/bathymetry/void → sea level

  cacheSet(pointCache, ck, elev, MAX_POINTS)
  return elev
}

// Returns AGL in metres, or null if elevation data unavailable.
// altMeters is the unit's MSL altitude from DCS (already in metres).
function getAgl(lat, lon, altMeters) {
  const terrain = getElevation(lat, lon)
  if (terrain === null) return null
  return altMeters - terrain
}

const EARTH_RADIUS_M     = 6371000
// Low-altitude warning terrain: the highest terrain in fixed 2 NM square
// bins, sampled at the aircraft's position and every 10 s along its current
// track out to 60 s (30 s look-ahead plus the 5-degree climb check beyond it).
const BIN_DEG     = 1 / 30          // 2 NM of latitude
const MAX_BINS    = 50_000
const SAMPLE_S    = [0, 10, 20, 30, 40, 50, 60]
let binCache      = new Map()       // "i,j" -> metres MSL | null

// Highest terrain (metres MSL) in the 2 NM bin containing the point: the max
// over every elevation grid node (0.01 deg) inside it. Bins are latitude
// bands 1/30 deg tall, split into longitude steps that are 2 NM wide at the
// band's centre. null if none of its nodes have data.
function binMaxElevation(lat, lon) {
  const i      = Math.floor(lat / BIN_DEG)
  const latC   = (i + 0.5) * BIN_DEG
  const lonDeg = BIN_DEG / Math.cos(latC * Math.PI / 180)
  const j      = Math.floor(lon / lonDeg)
  const key    = `${i},${j}`
  if (binCache.has(key)) return cacheGet(binCache, key)

  let max = null
  const lat0 = i * BIN_DEG, lon0 = j * lonDeg
  for (let la = Math.ceil(lat0 * 100); la < (lat0 + BIN_DEG) * 100; la++) {
    for (let lo = Math.ceil(lon0 * 100); lo < (lon0 + lonDeg) * 100; lo++) {
      const e = getElevation(la / 100, lo / 100)
      if (e !== null && (max === null || e > max)) max = e
    }
  }
  cacheSet(binCache, key, max, MAX_BINS)
  return max
}

// Bin terrain at the current position and every 10 s ahead to 60 s on the
// current heading (radians true) and ground speed (m/s). null if any bin
// has no elevation data.
function terrainBins(lat, lon, headingRad, speedMps) {
  const cosLat = Math.cos(lat * Math.PI / 180)
  const out = []
  for (const t of SAMPLE_S) {
    const d    = speedMps * t
    const pLat = lat + (d * Math.cos(headingRad) / EARTH_RADIUS_M) * 180 / Math.PI
    const pLon = lon + (d * Math.sin(headingRad) / (EARTH_RADIUS_M * cosLat)) * 180 / Math.PI
    const elev = binMaxElevation(pLat, pLon)
    if (elev === null) return null
    out.push(elev)
  }
  return out
}

// Adds terrainBinsM to every aircraft/helicopter in a units delta that
// moved. Deltas only carry changed fields, so heading/speed/category fall
// back to the stored unit.
function enrichTerrainAhead(updated, getUnit) {
  for (const [id, unit] of Object.entries(updated)) {
    if (!unit.position) continue
    const prev     = getUnit(id) ?? {}
    const category = unit.category ?? prev.category
    if (category !== 'Aircraft' && category !== 'Helicopter') continue
    const heading = unit.heading ?? prev.heading
    const speed   = unit.speed   ?? prev.speed
    if (heading == null || speed == null) continue
    const bins = terrainBins(unit.position.lat, unit.position.lng, heading, speed)
    if (bins) unit.terrainBinsM = bins
  }
}

module.exports = { init, getElevation, getAgl, enrichTerrainAhead }
