'use strict'

const path = require('path')
const DB_PATH = path.join(__dirname, '../data/elevation.db')

let db          = null
let tileCache   = new Map()   // "lat0,lon0" → Buffer | null
let pointCache  = new Map()   // "lat100,lon100" → number | null

function init() {
  try {
    const Database = require('better-sqlite3')
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
    console.log('[elevation] database ready')
  } catch {
    console.warn('[elevation] no elevation database — AGL unavailable (run scripts/buildElevationDb.js)')
  }
}

function getTile(lat0, lon0) {
  const key = `${lat0},${lon0}`
  if (tileCache.has(key)) return tileCache.get(key)
  if (!db) { tileCache.set(key, null); return null }

  const row  = db.prepare('SELECT data FROM elevation_tiles WHERE lat0 = ? AND lon0 = ?').get(lat0, lon0)
  const tile = row ? Buffer.from(row.data) : null
  tileCache.set(key, tile)
  return tile
}

// Returns terrain elevation in metres MSL, or null if unavailable.
function getElevation(lat, lon) {
  const lat100 = Math.round(lat * 100)
  const lon100 = Math.round(lon * 100)
  const ck     = `${lat100},${lon100}`
  if (pointCache.has(ck)) return pointCache.get(ck)

  const lat0 = Math.floor(lat)
  const lon0 = Math.floor(lon)
  const tile = getTile(lat0, lon0)

  if (!tile) { pointCache.set(ck, null); return null }

  const row  = Math.min(100, Math.max(0, Math.round((lat0 + 1 - lat) * 100)))
  const col  = Math.min(100, Math.max(0, Math.round((lon - lon0)     * 100)))
  const idx  = row * 101 + col
  const raw  = tile.readInt16BE(idx * 2)
  const elev = raw <= 0 ? 0 : raw   // ocean/bathymetry/void → sea level

  pointCache.set(ck, elev)
  return elev
}

// Returns AGL in metres, or null if elevation data unavailable.
// altMeters is the unit's MSL altitude from DCS (already in metres).
function getAgl(lat, lon, altMeters) {
  const terrain = getElevation(lat, lon)
  if (terrain === null) return null
  return altMeters - terrain
}

module.exports = { init, getElevation, getAgl }
