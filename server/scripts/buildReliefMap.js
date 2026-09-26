'use strict'

// Builds a banded terrain-relief overlay from the SRTM elevation database
// (see buildElevationDb.js). For every node on a working grid it samples the
// terrain elevation, bands it, and contours the result into nested polygons —
// a shaded-relief reference layer for the scope. Pure terrain height; no
// clearance, buffers, or vectoring-altitude logic.
//
// Usage:
//   node server/scripts/buildReliefMap.js            # all theatres
//   node server/scripts/buildReliefMap.js Caucasus   # one theatre
//
// Outputs:
//   server/data/relief-preview/<folder>.bmp   hypsometric raster for eyeballing
//   server/navdata/cache/<folder>/relief.json contour polygons (needs d3-contour)

const path = require('path')
const fs   = require('fs')
const { writeBMP } = require('./lib/bmpEncoder.js')

let Database
try {
  Database = require('better-sqlite3')
} catch {
  console.error('better-sqlite3 not found. Run: npm install (in server/)')
  process.exit(1)
}

// ── Tunables ──────────────────────────────────────────────────────────────────
const RES_DEG      = 0.01         // DEM resolution (matches buildElevationDb)
const STEP_DEG     = 0.02         // working-grid spacing (~1.2 NM)
const BAND_FT      = Number(process.env.RELIEF_BAND) || 500   // elevation band / contour step
const MOSAIC_PAD_NM = 2           // small extra mosaic-only pad so edge nodes of the
                                   // (already FIELD_PAD_NM-padded, see below) field
                                   // have real data on both sides to sample/interpolate

// Relief's contour field is padded beyond the theatre bbox because every *other*
// layer that shares that bbox extends beyond it (buildGeoData.js pads +1°; buildAbmBasemap.js's canvas itself pads
// +15NM, "PAD_NM" there, so panning past the edge isn't blank). Without padding,
// the gap between relief's edge and those wider edges reads as land (correctly drawn by
// geo.json) with an abrupt, dead-straight cutoff to zero relief shading — often
// mid-terrain, not at any real coastline or feature boundary, once a theatre's
// bbox edge happens to land inside a mountain range instead of open desert/sea.
// FIELD_PAD_NM must stay >= buildAbmBasemap.js's own PAD_NM (currently 15NM) so
// the basemap's visible canvas is never wider than what relief actually covers;
// kept a bit larger for headroom. If that basemap constant changes, revisit this.
const FIELD_PAD_NM = 20
const SIMPLIFY_NM  = 0.3          // Douglas–Peucker tolerance for contour rings
const MIN_AREA_NM2 = 2            // drop polygons/holes smaller than this
const MAX_ELEV_M   = 9000         // clamp voids/NODATA (Everest ≈ 8849 m)
const M2FT         = 3.28084
const D2R          = Math.PI / 180

const DB_PATH       = path.join(__dirname, '../data/elevation.db')
const THEATRES_PATH = path.join(__dirname, '../navdata/config/theatres.json')
const CACHE_DIR     = path.join(__dirname, '../navdata/cache')
const PREVIEW_DIR   = path.join(__dirname, '../data/relief-preview')

const snap01 = (x) => Math.round(x * 100) / 100

// Expands a [lonMin,latMin,lonMax,latMax] bbox by `nm` nautical miles on every
// side (longitude scaled by cosLat, same approach buildMosaic() already used
// for its own internal pad below). Used to grow the theatre bbox by
// FIELD_PAD_NM *before* it's handed to buildMosaic/computeField/vectorize, so
// relief's actual contour data — not just the mosaic's internal lookup buffer
// — extends past the raw bbox. See FIELD_PAD_NM's comment for why.
function padBbox([lonMin, latMin, lonMax, latMax], nm) {
  const maxAbsLat = Math.max(Math.abs(latMin), Math.abs(latMax))
  const cosLat    = Math.max(0.2, Math.cos(maxAbsLat * D2R))
  const latPad    = nm / 60
  const lonPad    = nm / 60 / cosLat
  return [lonMin - lonPad, latMin - latPad, lonMax + lonPad, latMax + latPad]
}

// ── DEM mosaic ──────────────────────────────────────────────────────────────
// Assemble the 1°×1° tiles covering the padded bbox into one Int16Array at
// RES_DEG. Row 0 = north edge (latMaxP), col 0 = west edge (lonMinP). Missing
// tiles stay 0. Bounds snapped to 0.01° so tile samples land on mosaic cells.
function buildMosaic(db, bbox) {
  const [lonMin, latMin, lonMax, latMax] = bbox

  const maxAbsLat = Math.max(Math.abs(latMin), Math.abs(latMax))
  const cosLat    = Math.max(0.2, Math.cos(maxAbsLat * D2R))
  const latPad    = MOSAIC_PAD_NM / 60
  const lonPad    = MOSAIC_PAD_NM / 60 / cosLat

  const lonMinP = snap01(Math.floor((lonMin - lonPad) * 100) / 100)
  const lonMaxP = snap01(Math.ceil((lonMax + lonPad) * 100) / 100)
  const latMinP = snap01(Math.floor((latMin - latPad) * 100) / 100)
  const latMaxP = snap01(Math.ceil((latMax + latPad) * 100) / 100)

  const cols = Math.round((lonMaxP - lonMinP) * 100) + 1
  const rows = Math.round((latMaxP - latMinP) * 100) + 1
  const data = new Int16Array(rows * cols)

  const stmt = db.prepare('SELECT data FROM elevation_tiles WHERE lat0 = ? AND lon0 = ?')

  let tilesFound = 0
  for (let lat0 = Math.floor(latMinP); lat0 < Math.ceil(latMaxP); lat0++) {
    for (let lon0 = Math.floor(lonMinP); lon0 < Math.ceil(lonMaxP); lon0++) {
      const row = stmt.get(lat0, lon0)
      if (!row) continue
      tilesFound++
      const buf = Buffer.from(row.data)
      for (let ti = 0; ti <= 100; ti++) {
        const sampleLat = lat0 + 1 - ti * RES_DEG
        const mr = Math.round((latMaxP - sampleLat) * 100)
        if (mr < 0 || mr >= rows) continue
        for (let tj = 0; tj <= 100; tj++) {
          const sampleLon = lon0 + tj * RES_DEG
          const mc = Math.round((sampleLon - lonMinP) * 100)
          if (mc < 0 || mc >= cols) continue
          data[mr * cols + mc] = buf.readInt16BE((ti * 101 + tj) * 2)
        }
      }
    }
  }

  return { data, rows, cols, lonMinP, latMaxP, tilesFound }
}

// ── Banded elevation field ──────────────────────────────────────────────────
function computeField(mosaic, bbox) {
  const { data, rows, cols, lonMinP, latMaxP } = mosaic
  const [lonMin, latMin, lonMax, latMax] = bbox

  const fw = Math.round((lonMax - lonMin) / STEP_DEG) + 1
  const fh = Math.round((latMax - latMin) / STEP_DEG) + 1

  const elev = new Int16Array(fw * fh)   // banded elevation, ft
  let minFt = Infinity, maxFt = -Infinity

  for (let fi = 0; fi < fh; fi++) {
    const nodeLat = latMax - fi * STEP_DEG
    const mr = Math.round((latMaxP - nodeLat) * 100)
    for (let fj = 0; fj < fw; fj++) {
      const nodeLon = lonMin + fj * STEP_DEG
      const mc = Math.round((nodeLon - lonMinP) * 100)

      let m = 0
      if (mr >= 0 && mr < rows && mc >= 0 && mc < cols) m = data[mr * cols + mc]
      if (m < 0 || m > MAX_ELEV_M) m = 0

      const ft = Math.floor((m * M2FT) / BAND_FT) * BAND_FT
      const idx = fi * fw + fj
      elev[idx] = ft
      if (ft < minFt) minFt = ft
      if (ft > maxFt) maxFt = ft
    }
  }

  return { elev, fw, fh, minFt, maxFt }
}

// ── Hypsometric preview ramp (elev ft → [r,g,b]) ────────────────────────────────
const RAMP = [
  [    0, [ 40,  90, 110]],
  [ 1500, [ 60, 120,  80]],
  [ 3000, [110, 170,  90]],
  [ 5000, [225, 210, 120]],
  [ 8000, [200, 140,  80]],
  [11000, [180,  90,  70]],
  [14000, [240, 240, 250]],
]
function hypso(ft) {
  if (ft <= RAMP[0][0]) return RAMP[0][1]
  if (ft >= RAMP[RAMP.length - 1][0]) return RAMP[RAMP.length - 1][1]
  for (let i = 1; i < RAMP.length; i++) {
    if (ft <= RAMP[i][0]) {
      const [a, ca] = RAMP[i - 1]
      const [b, cb] = RAMP[i]
      const t = (ft - a) / (b - a)
      return [
        Math.round(ca[0] + (cb[0] - ca[0]) * t),
        Math.round(ca[1] + (cb[1] - ca[1]) * t),
        Math.round(ca[2] + (cb[2] - ca[2]) * t),
      ]
    }
  }
  return RAMP[RAMP.length - 1][1]
}

// ── Ring geometry / simplification ──────────────────────────────────────────────
function ringAreaNm2(ring) {
  let latSum = 0
  for (const p of ring) latSum += p[1]
  const sx = Math.cos((latSum / ring.length) * D2R) * 60
  let a = 0
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * sx * (ring[i + 1][1] * 60) - ring[i + 1][0] * sx * (ring[i][1] * 60)
  }
  return Math.abs(a) / 2
}

function simplifyRing(ring, cosLat) {
  if (ring.length < 5) return ring
  const tol = SIMPLIFY_NM / 60
  const pts = ring.slice(0, ring.length - 1)
  const n   = pts.length
  const keep = new Uint8Array(n)
  keep[0] = keep[n - 1] = 1
  const stack = [[0, n - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    const ax = pts[a][0] * cosLat, ay = pts[a][1]
    const bx = pts[b][0] * cosLat, by = pts[b][1]
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy || 1e-12
    let maxD = -1, idx = -1
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0] * cosLat, py = pts[i][1]
      const t  = ((px - ax) * dx + (py - ay) * dy) / len2
      const cx = ax + t * dx, cy = ay + t * dy
      const d  = Math.hypot(px - cx, py - cy)
      if (d > maxD) { maxD = d; idx = i }
    }
    if (maxD > tol && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]) }
  }
  const out = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i])
  out.push(out[0])
  return out
}

// ── Vectorize to relief.json via d3-contour ─────────────────────────────────────
async function vectorize(field, bbox) {
  let d3
  try { d3 = await import('d3-contour') } catch { return null }

  const { elev, fw, fh, minFt, maxFt } = field
  const [lonMin, latMin, , latMax] = bbox
  const cosLat = Math.cos(((latMin + latMax) / 2) * D2R)

  const levels = []
  for (let v = Math.ceil(minFt / BAND_FT) * BAND_FT; v <= maxFt; v += BAND_FT) levels.push(v)

  const contours = d3.contours().size([fw, fh]).thresholds(levels)(Array.from(elev))
  const toLL = ([x, y]) => [snap01(lonMin + x * STEP_DEG), snap01(latMax - y * STEP_DEG)]

  const regions = []
  for (const c of contours) {
    if (!c.value) continue
    for (const poly of c.coordinates) {
      const outer = simplifyRing(poly[0].map(toLL), cosLat)
      if (ringAreaNm2(outer) < MIN_AREA_NM2) continue
      const rings = [outer]
      for (let h = 1; h < poly.length; h++) {
        const hole = simplifyRing(poly[h].map(toLL), cosLat)
        if (ringAreaNm2(hole) >= MIN_AREA_NM2) rings.push(hole)
      }
      regions.push({ elev: c.value, rings })
    }
  }
  return regions
}

// ── Driver ──────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No elevation DB at ${DB_PATH}\nRun: node server/scripts/buildElevationDb.js`)
    process.exit(1)
  }

  const theatres = JSON.parse(fs.readFileSync(THEATRES_PATH, 'utf8'))
  const only = process.argv[2]
  if (only && !theatres[only]) {
    console.error(`Unknown theatre "${only}". Options: ${Object.keys(theatres).join(', ')}`)
    process.exit(1)
  }

  fs.mkdirSync(PREVIEW_DIR, { recursive: true })
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })

  const entries = only ? [[only, theatres[only]]] : Object.entries(theatres)
  console.log(`\nBuilding terrain relief - ${entries.length} theatre(s)  ·  grid ${STEP_DEG}° · ${BAND_FT}ft bands\n`)

  let anyVectorized = false
  for (const [name, conf] of entries) {
    const t0 = process.hrtime.bigint()
    // Field/contour data is computed over conf.bbox expanded by FIELD_PAD_NM,
    // not the raw theatre bbox — see FIELD_PAD_NM's comment above for why
    // (relief used to stop dead at the exact bbox edge while geo.json's land
    // and the basemap's own canvas both extend past it).
    const fieldBbox = padBbox(conf.bbox, FIELD_PAD_NM)
    const mosaic = buildMosaic(db, fieldBbox)
    const field  = computeField(mosaic, fieldBbox)

    writeBMP(path.join(PREVIEW_DIR, `${conf.folder}.bmp`), field.fw, field.fh,
      (x, y) => hypso(field.elev[y * field.fw + x]))

    const regions = await vectorize(field, fieldBbox)
    if (regions) {
      anyVectorized = true
      const outDir = path.join(CACHE_DIR, conf.folder)
      fs.mkdirSync(outDir, { recursive: true })
      fs.writeFileSync(path.join(outDir, 'relief.json'), JSON.stringify(regions))
    }

    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    console.log(
      `${name.padEnd(16)} ${String(field.fw).padStart(4)}×${String(field.fh).padEnd(4)} ` +
      `tiles ${String(mosaic.tilesFound).padStart(3)} · elev ${field.minFt}–${field.maxFt}ft · ` +
      `${regions ? regions.length + ' bands' : 'preview only'} · ${ms.toFixed(0)}ms`
    )
  }

  db.close()
  console.log(`\nPreviews → ${PREVIEW_DIR}`)
  if (!anyVectorized) console.log(`\nTo emit cache/<folder>/relief.json: npm i d3-contour  then re-run.`)
  console.log('')
}

main().catch((err) => { console.error(err); process.exit(1) })
