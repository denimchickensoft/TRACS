'use strict'

// Downloads SRTM elevation tiles from the AWS elevation-tiles-prod bucket
// (public, no auth) and builds a compact SQLite database trimmed to DCS
// theatre bounding boxes.
//
// Usage:  node server/scripts/buildElevationDb.js
// Output: server/data/elevation.db  (~15–25 MB, safe to commit)
//
// Each 1°×1° tile is stored as a 101×101 int16 blob at 0.01° (~1.1 km)
// resolution — fine enough for AGL alerting and radar ground filtering.

const https   = require('https')
const zlib    = require('zlib')
const path    = require('path')
const fs      = require('fs')

let Database
try {
  Database = require('better-sqlite3')
} catch {
  console.error('better-sqlite3 not found. Run: npm install (in server/)')
  process.exit(1)
}

const DB_PATH = path.join(__dirname, '../data/elevation.db')

// DCS theatre bboxes — SW corner (inclusive) to NE corner (exclusive)
const THEATRES = [
  { name: 'Caucasus',       latMin: 38, latMax: 48, lonMin: 27,   lonMax: 47  },
  { name: 'Nevada',         latMin: 34, latMax: 40, lonMin: -120, lonMax: -113 },
  { name: 'PersianGulf',    latMin: 22, latMax: 29, lonMin: 49,   lonMax: 63  },
  { name: 'Syria',          latMin: 32, latMax: 38, lonMin: 34,   lonMax: 43  },
  { name: 'MarianaIslands', latMin: 13, latMax: 21, lonMin: 143,  lonMax: 149 },
  { name: 'SouthAtlantic',  latMin: -54, latMax: -50, lonMin: -62, lonMax: -56 },
  { name: 'SinaiMap',       latMin: 28, latMax: 34, lonMin: 30,   lonMax: 40  },
  { name: 'Kola',           latMin: 66, latMax: 72, lonMin: 24,   lonMax: 41  },
  { name: 'Afghanistan',    latMin: 29, latMax: 39, lonMin: 60,   lonMax: 76  },
  { name: 'Germany',        latMin: 47, latMax: 56, lonMin: 5,    lonMax: 17  },
]

// Collect unique 1°×1° tiles needed across all theatres
const tileSet = new Set()
for (const t of THEATRES) {
  for (let lat = t.latMin; lat < t.latMax; lat++) {
    for (let lon = t.lonMin; lon < t.lonMax; lon++) {
      tileSet.add(`${lat},${lon}`)
    }
  }
}

function tileName(lat0, lon0) {
  const la = lat0 >= 0 ? `N${String(lat0).padStart(2, '0')}`        : `S${String(-lat0).padStart(2, '0')}`
  const lo = lon0 >= 0 ? `E${String(lon0).padStart(3, '0')}`        : `W${String(-lon0).padStart(3, '0')}`
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

// Sample a raw HGT buffer down to a 101×101 int16 blob at 0.01° resolution.
// Row 0 = north edge (lat0+1), Row 100 = south edge (lat0).
// Col 0 = west edge (lon0),  Col 100 = east edge (lon0+1).
function buildBlob(hgtBuffer) {
  const srtm1Bytes = 3601 * 3601 * 2
  const srtm3Bytes = 1201 * 1201 * 2
  let gridSize

  if (hgtBuffer.length >= srtm1Bytes) {
    gridSize = 3601
  } else if (hgtBuffer.length >= srtm3Bytes) {
    gridSize = 1201
  } else {
    return null  // unexpected size
  }

  const span = gridSize - 1  // 3600 for SRTM1, 1200 for SRTM3
  const blob = Buffer.allocUnsafe(101 * 101 * 2)

  for (let ri = 0; ri <= 100; ri++) {
    for (let ci = 0; ci <= 100; ci++) {
      const hgtRow = Math.round(ri * span / 100)
      const hgtCol = Math.round(ci * span / 100)
      const hgtIdx = hgtRow * gridSize + hgtCol
      const val    = hgtBuffer.readInt16BE(hgtIdx * 2)
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

async function build() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH)

  const db = new Database(DB_PATH)
  db.exec(`
    CREATE TABLE elevation_tiles (
      lat0 INTEGER NOT NULL,
      lon0 INTEGER NOT NULL,
      data BLOB    NOT NULL,
      PRIMARY KEY (lat0, lon0)
    )
  `)

  const insert = db.prepare('INSERT INTO elevation_tiles (lat0, lon0, data) VALUES (?, ?, ?)')

  const tiles = [...tileSet].map((k) => k.split(',').map(Number))
  console.log(`\nBuilding elevation DB — ${tiles.length} tiles across ${THEATRES.length} theatres`)
  console.log(`Source: AWS elevation-tiles-prod (SRTM, public domain)\n`)

  const BATCH = 10
  let done = 0, inserted = 0, skipped = 0

  for (let i = 0; i < tiles.length; i += BATCH) {
    const batch    = tiles.slice(i, i + BATCH)
    const buffers  = await runBatch(batch, BATCH)

    db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const [lat0, lon0] = batch[j]
        done++
        process.stdout.write(`\r  [${done}/${tiles.length}] ${tileName(lat0, lon0)}          `)

        const buf  = buffers[j]
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

  const { size } = fs.statSync(DB_PATH)
  console.log(`\n\nDone.`)
  console.log(`  Tiles inserted : ${inserted}`)
  console.log(`  Tiles skipped  : ${skipped} (ocean/missing)`)
  console.log(`  Database size  : ${(size / 1024 / 1024).toFixed(1)} MB`)
  console.log(`  Output         : ${DB_PATH}`)
}

build().catch(console.error)
