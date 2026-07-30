'use strict'

// One-off incremental companion to buildElevationDb.js: fetches only tiles
// that are missing from the existing DB (derived the same way, from
// theatres.json bboxes + MARGIN_DEG) instead of buildElevationDb.js's
// full from-scratch rebuild-and-swap. Useful right after widening a
// theatre's bbox, where re-downloading all ~1700 already-cached tiles is
// wasted bandwidth for the sake of a handful of new ones. Inserts directly
// into the existing server/data/elevation.db in place — no temp file, no
// swap, so it can't hit the Windows file-lock-on-swap issue
// buildElevationDb.js can when a server process has the db open (reads
// don't conflict with these inserts the way a rename-over-open-file does).
//
// Usage: node server/scripts/addElevationTiles.js

const https = require('https')
const zlib  = require('zlib')
const path  = require('path')
const fs    = require('fs')

let Database
try {
  Database = require('better-sqlite3')
} catch {
  console.error('better-sqlite3 not found. Run: npm install (in server/)')
  process.exit(1)
}

const DB_PATH       = path.join(__dirname, '../data/elevation.db')
const THEATRES_PATH = path.join(__dirname, '../navdata/config/theatres.json')
const MARGIN_DEG    = 1

const theatreConf = JSON.parse(fs.readFileSync(THEATRES_PATH, 'utf8'))
const needed = new Set()
for (const { bbox } of Object.values(theatreConf)) {
  const [lonMin, latMin, lonMax, latMax] = bbox
  const latLo = Math.floor(latMin - MARGIN_DEG), latHi = Math.ceil(latMax + MARGIN_DEG)
  const lonLo = Math.floor(lonMin - MARGIN_DEG), lonHi = Math.ceil(lonMax + MARGIN_DEG)
  for (let lat = latLo; lat < latHi; lat++) {
    for (let lon = lonLo; lon < lonHi; lon++) needed.add(`${lat},${lon}`)
  }
}

function tileName(lat0, lon0) {
  const la = lat0 >= 0 ? `N${String(lat0).padStart(2, '0')}` : `S${String(-lat0).padStart(2, '0')}`
  const lo = lon0 >= 0 ? `E${String(lon0).padStart(3, '0')}` : `W${String(-lon0).padStart(3, '0')}`
  return `${la}${lo}`
}
function tileDir(lat0) {
  return lat0 >= 0 ? `N${String(lat0).padStart(2, '0')}` : `S${String(-lat0).padStart(2, '0')}`
}

function downloadTile(lat0, lon0) {
  return new Promise((resolve) => {
    const name = tileName(lat0, lon0)
    const dir  = tileDir(lat0)
    const url  = `https://s3.amazonaws.com/elevation-tiles-prod/skadi/${dir}/${name}.hgt.gz`
    const req = https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return }
      const chunks = []
      const gunzip = zlib.createGunzip()
      res.pipe(gunzip)
      gunzip.on('data', (c) => chunks.push(c))
      gunzip.on('end',  () => resolve(Buffer.concat(chunks)))
      gunzip.on('error', () => resolve(null))
    })
    req.on('error',   () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

function buildBlob(hgtBuffer) {
  const srtm1Bytes = 3601 * 3601 * 2
  const srtm3Bytes = 1201 * 1201 * 2
  let gridSize
  if (hgtBuffer.length >= srtm1Bytes) gridSize = 3601
  else if (hgtBuffer.length >= srtm3Bytes) gridSize = 1201
  else return null

  const span = gridSize - 1
  const blob = Buffer.allocUnsafe(101 * 101 * 2)
  for (let ri = 0; ri <= 100; ri++) {
    for (let ci = 0; ci <= 100; ci++) {
      const hgtRow = Math.round(ri * span / 100)
      const hgtCol = Math.round(ci * span / 100)
      const hgtIdx = hgtRow * gridSize + hgtCol
      const val = hgtBuffer.readInt16BE(hgtIdx * 2)
      blob.writeInt16BE(val, (ri * 101 + ci) * 2)
    }
  }
  return blob
}

async function runBatch(tiles, concurrency) {
  const results = []
  let idx = 0
  async function worker() {
    while (idx < tiles.length) {
      const i = idx++
      results[i] = await downloadTile(tiles[i][0], tiles[i][1])
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return results
}

async function main() {
  const db = new Database(DB_PATH)
  const existing = new Set(
    db.prepare('SELECT lat0, lon0 FROM elevation_tiles').all().map((r) => `${r.lat0},${r.lon0}`)
  )
  const missing = [...needed].filter((k) => !existing.has(k)).map((k) => k.split(',').map(Number))

  console.log(`\n${needed.size} tiles needed total, ${existing.size} already present, ${missing.length} missing\n`)
  if (missing.length === 0) { console.log('Nothing to do.\n'); db.close(); return }

  const insert = db.prepare('INSERT OR IGNORE INTO elevation_tiles (lat0, lon0, data) VALUES (?, ?, ?)')
  const BATCH = 10
  let done = 0, inserted = 0, skipped = 0

  for (let i = 0; i < missing.length; i += BATCH) {
    const batch   = missing.slice(i, i + BATCH)
    const buffers = await runBatch(batch, BATCH)
    db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const [lat0, lon0] = batch[j]
        done++
        process.stdout.write(`\r  [${done}/${missing.length}] ${tileName(lat0, lon0)}          `)
        const buf = buffers[j]
        if (!buf) { skipped++; continue }
        const blob = buildBlob(buf)
        if (!blob) { skipped++; continue }
        insert.run(lat0, lon0, blob)
        inserted++
      }
    })()
  }

  db.exec('ANALYZE')
  db.close()
  console.log(`\n\nDone. Inserted ${inserted}, skipped ${skipped} (ocean/missing).`)
}

main().catch((err) => { console.error(err); process.exit(1) })
