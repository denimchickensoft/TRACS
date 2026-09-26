'use strict'

// Builds a synthetic, facility-scoped MVA (Minimum Vectoring Altitude) layer
// from the SRTM elevation database (see buildElevationDb.js). Unlike the RELIEF
// layer (continuous terrain contours), this produces a *coarse partition* of one
// approach control's airspace into a handful of labeled sectors, each carrying a
// single conservative "don't vector below this here" floor — the artifact shape
// of a real FAA MVA chart.
//
// Terrain-only approximation: clears the highest terrain in each sector + buffer
// + clearance, rounded up to 100 ft. No man-made obstacles (no data for DCS).
//
// Pipeline (per facility):
//   1. Mosaic the elevation tiles over a radius R around the facility center.
//   2. Grid the coverage into G-NM merge cells; per cell compute a conservative
//      MVA = roundUp100(maxTerrain(cell+buffer) + clearance).
//   3. Quantize each cell's MVA to tolerance T (mergeKey), then 4-connected
//      components on equal mergeKey → sectors (deterministic).
//   4. Trace sectors from shared cell edges, smooth the welded boundary graph,
//      place a label per sector via polylabel.
//
// Usage:
//   node server/scripts/buildMvaMap.js            # every facility, all theatres
//   node server/scripts/buildMvaMap.js KLAS       # one facility (ICAO)
//   node server/scripts/buildMvaMap.js Nevada     # all facilities in a theatre
//   node server/scripts/buildMvaMap.js [filter] [--lnm-path <path>]
//
// --lnm-path (optional) points at a local LittleNavMap navigraph sqlite DB,
// used only as a supplementary airbase-coordinate source. resources/ is
// gitignored and not part of the committed project, so this never assumes a
// specific resources/ subfolder — the caller says where their own copy
// lives, and the enrichment is simply skipped (not an error) if omitted.
//
// Outputs:
//   server/navdata/cache/<folder>/mva/<ICAO>.json   sector polygons
//   server/data/mva-preview/<ICAO>.bmp              merge-cell MVA raster (debug)

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

let polylabel
try {
  const pl = require('polylabel')
  polylabel = pl.default || pl
} catch {
  console.error('polylabel not found. Run: npm i polylabel (in server/)')
  process.exit(1)
}

// ── Tunables ──────────────────────────────────────────────────────────────────
const RES_DEG       = 0.01    // DEM resolution (matches buildElevationDb)
const R_NM          = Number(process.env.MVA_R) || 50    // facility coverage radius
const G_NM          = Number(process.env.MVA_G) || 5     // merge-unit grid cell
const T_FT          = Number(process.env.MVA_T) || 500   // merge tolerance (quantize)
const BUFFER_NM     = 3        // lateral obstacle buffer (real MVA buffers 3 NM)
const MTN_WINDOW_NM = 10       // mountainous test window (14 CFR 95-B: Δ>3000/10NM)
const MTN_DELTA_FT  = 3000     // mountainous threshold
const CLEAR_FLAT_FT = 1000     // clearance, non-mountainous
const CLEAR_MTN_FT  = 2000     // clearance, mountainous
const MIN_SECTOR_NM2 = Number(process.env.MVA_MINAREA) || 75  // absorb sectors smaller than this; ~3 cells at G=5 (merge-cell granular — <CELL_NM2 absorbs nothing)
const CELL_NM2       = G_NM * G_NM   // area of one merge cell (~25 NM² at G=5)
const SMOOTH_ITERS   = 6       // Taubin smoothing passes on the shared boundary graph
const TAUBIN_LAMBDA  = 0.5     // Taubin shrink step
const TAUBIN_MU      = -0.53   // Taubin anti-shrink step (|μ| > λ keeps area stable)
const MIN_AREA_NM2  = 4        // drop rings/holes smaller than this
const MAX_ELEV_M    = 9000     // clamp voids/NODATA (Everest ≈ 8849 m)
const PAD_NM        = 14       // mosaic pad ≥ MTN_WINDOW + BUFFER so edges have data
const M2FT          = 3.28084
const D2R           = Math.PI / 180

const DB_PATH       = path.join(__dirname, '../data/elevation.db')
const THEATRES_PATH = path.join(__dirname, '../navdata/config/theatres.json')
const SECTORS_PATH  = path.join(__dirname, '../navdata/cache/sectors.json')
const ICAOMAP_PATH  = path.join(__dirname, '../../client/public/icaoMapping.json')
const RUNWAYS_DIR   = path.join(__dirname, '../../client/public/runways')
const lnmArgIdx     = process.argv.indexOf('--lnm-path')
const LNM_DB_PATH   = lnmArgIdx !== -1 ? process.argv[lnmArgIdx + 1] : null
const CACHE_DIR     = path.join(__dirname, '../navdata/cache')
const PREVIEW_DIR   = path.join(__dirname, '../data/mva-preview')

const snap01      = (x) => Math.round(x * 100) / 100
const roundUp100  = (x) => Math.ceil(x / 100) * 100

// ── DEM mosaic ──────────────────────────────────────────────────────────────
// Assemble the 1°×1° tiles covering the padded bbox into one Int16Array at
// RES_DEG (metres). Row 0 = north edge (latMaxP), col 0 = west edge (lonMinP).
// Forked verbatim from buildReliefMap.js.
function buildMosaic(db, bbox) {
  const [lonMin, latMin, lonMax, latMax] = bbox

  const maxAbsLat = Math.max(Math.abs(latMin), Math.abs(latMax))
  const cosLat    = Math.max(0.2, Math.cos(maxAbsLat * D2R))
  const latPad    = PAD_NM / 60
  const lonPad    = PAD_NM / 60 / cosLat

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

// max/min terrain (ft) over a lat/lon window of the given NM radius around a node
function windowStats(mosaic, lat, lon, radiusNm, cosLat) {
  const { data, rows, cols, lonMinP, latMaxP } = mosaic
  const dLat = radiusNm / 60
  const dLon = radiusNm / 60 / cosLat

  const r0 = Math.round((latMaxP - (lat + dLat)) * 100)
  const r1 = Math.round((latMaxP - (lat - dLat)) * 100)
  const c0 = Math.round(((lon - dLon) - lonMinP) * 100)
  const c1 = Math.round(((lon + dLon) - lonMinP) * 100)

  let mn = Infinity, mx = -Infinity
  for (let r = Math.max(0, r0); r <= Math.min(rows - 1, r1); r++) {
    for (let c = Math.max(0, c0); c <= Math.min(cols - 1, c1); c++) {
      let m = data[r * cols + c]
      if (m < 0 || m > MAX_ELEV_M) m = 0
      const ft = m * M2FT
      if (ft < mn) mn = ft
      if (ft > mx) mx = ft
    }
  }
  if (mx < 0) { mn = 0; mx = 0 }   // entirely out of mosaic → sea floor
  return { min: mn, max: mx }
}

// ── Merge-cell MVA grid ───────────────────────────────────────────────────────
// Node (gi,gj) sits at lat = latMax - gi*Gdeg, lon = lonMin + gj*Gdeg; the tracer
// treats each node as a unit cell centred there. Cells whose center is > R NM from
// the facility are masked out → circular coverage.
function buildCellGrid(mosaic, center) {
  const cosLat   = Math.cos(center.lat * D2R)
  const rDegLat  = R_NM / 60
  const rDegLon  = R_NM / 60 / cosLat
  const gDegLat  = G_NM / 60
  const gDegLon  = G_NM / 60 / cosLat

  const latMax = center.lat + rDegLat
  const lonMin = center.lon - rDegLon
  const gw = Math.round((2 * rDegLon) / gDegLon) + 1
  const gh = Math.round((2 * rDegLat) / gDegLat) + 1

  const cellMva  = new Float64Array(gw * gh)
  const mergeKey = new Float64Array(gw * gh)
  const inMask   = new Uint8Array(gw * gh)

  const maxRadNm = G_NM / 2 + BUFFER_NM   // cell half-extent + obstacle buffer

  let nIn = 0
  for (let gi = 0; gi < gh; gi++) {
    const lat = latMax - gi * gDegLat
    for (let gj = 0; gj < gw; gj++) {
      const lon = lonMin + gj * gDegLon
      const idx = gi * gw + gj

      const dNm = Math.hypot((lat - center.lat) * 60, (lon - center.lon) * 60 * cosLat)
      if (dNm > R_NM) continue
      inMask[idx] = 1
      nIn++

      const obst = windowStats(mosaic, lat, lon, maxRadNm, cosLat)
      const wide = windowStats(mosaic, lat, lon, MTN_WINDOW_NM, cosLat)
      const mountainous = (wide.max - wide.min) > MTN_DELTA_FT
      const clearance   = mountainous ? CLEAR_MTN_FT : CLEAR_FLAT_FT

      const mva = roundUp100(obst.max + clearance)
      cellMva[idx]  = mva
      mergeKey[idx] = Math.ceil(mva / T_FT) * T_FT
    }
  }

  return { cellMva, mergeKey, inMask, gw, gh, lonMin, latMax, gDegLat, gDegLon, nIn }
}

// ── Tolerance merge → sectors (quantize-then-connected-components) ────────────
const NB4 = [[-1, 0], [1, 0], [0, -1], [0, 1]]

function labelComponents(mergeKey, inMask, gw, gh) {
  const comp = new Int32Array(gw * gh).fill(-1)
  const queue = new Int32Array(gw * gh)
  let nComp = 0
  for (let s = 0; s < gw * gh; s++) {
    if (!inMask[s] || comp[s] !== -1) continue
    const key = mergeKey[s]
    let head = 0, tail = 0
    queue[tail++] = s
    comp[s] = nComp
    while (head < tail) {
      const idx = queue[head++]
      const ci = (idx / gw) | 0, cj = idx % gw
      for (const [di, dj] of NB4) {
        const ni = ci + di, nj = cj + dj
        if (ni < 0 || ni >= gh || nj < 0 || nj >= gw) continue
        const nIdx = ni * gw + nj
        if (!inMask[nIdx] || comp[nIdx] !== -1 || mergeKey[nIdx] !== key) continue
        comp[nIdx] = nComp
        queue[tail++] = nIdx
      }
    }
    nComp++
  }
  return { comp, nComp }
}

// Absorb sub-threshold sectors into their highest-MVA neighbour (never lower a
// sector — that would under-warn). Mutates mergeKey, then re-labels.
function absorbSmall(grid) {
  const { mergeKey, inMask, gw, gh } = grid
  for (let pass = 0; pass < 4; pass++) {
    const { comp, nComp } = labelComponents(mergeKey, inMask, gw, gh)
    const size = new Int32Array(nComp)
    for (let i = 0; i < gw * gh; i++) if (comp[i] >= 0) size[comp[i]]++

    let changed = false
    for (let c = 0; c < nComp; c++) {
      if (size[c] * CELL_NM2 >= MIN_SECTOR_NM2) continue
      // best (highest) neighbouring mergeKey across the component boundary
      let best = -Infinity
      for (let i = 0; i < gw * gh; i++) {
        if (comp[i] !== c) continue
        const ci = (i / gw) | 0, cj = i % gw
        for (const [di, dj] of NB4) {
          const ni = ci + di, nj = cj + dj
          if (ni < 0 || ni >= gh || nj < 0 || nj >= gw) continue
          const nIdx = ni * gw + nj
          if (!inMask[nIdx] || comp[nIdx] === c) continue
          if (mergeKey[nIdx] > best) best = mergeKey[nIdx]
        }
      }
      // only absorb upward; a small local-high sector is kept as-is
      if (best > -Infinity && best > mergeKey[firstCell(comp, c, gw * gh)]) {
        for (let i = 0; i < gw * gh; i++) if (comp[i] === c) mergeKey[i] = best
        changed = true
      }
    }
    if (!changed) return labelComponents(mergeKey, inMask, gw, gh)
  }
  return labelComponents(mergeKey, inMask, gw, gh)
}

function firstCell(comp, c, n) {
  for (let i = 0; i < n; i++) if (comp[i] === c) return i
  return 0
}

// ── Ring geometry / simplification (forked from buildReliefMap.js) ───────────
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

// Boundary vertices are cell corners — points on a fixed half-integer lattice — so
// a border shared by two sectors (and a corner where 3+ meet) is the *same* vertex
// in every ring. Keying by ×2-rounded grid coords welds them: one position per key.
const vKey = (x, y) => `${Math.round(x * 2)},${Math.round(y * 2)}`

// Taubin smoothing on the shared boundary graph: round corners without gaps and
// without shrinking. Only vertices with exactly 2 boundary neighbours move; a
// vertex where 3+ sectors meet (degree ≠ 2) is a junction and stays pinned, so
// straight runs stay straight, corners round, and the partition topology holds.
// Because positions are shared by key, both neighbours of a border move together
// — no ambiguous space opens between sectors. Membership/altitude are untouched.
function smoothShared(pos, nbrs, iters, lambda, mu) {
  const movable = []
  for (const [k, s] of nbrs) if (s.size === 2) movable.push(k)
  const step = (factor) => {
    const delta = new Map()
    for (const k of movable) {
      const [a, b] = [...nbrs.get(k)]
      const p = pos.get(k), pa = pos.get(a), pb = pos.get(b)
      delta.set(k, [factor * ((pa[0] + pb[0]) / 2 - p[0]), factor * ((pa[1] + pb[1]) / 2 - p[1])])
    }
    for (const k of movable) { const p = pos.get(k), d = delta.get(k); p[0] += d[0]; p[1] += d[1] }
  }
  for (let i = 0; i < iters; i++) { step(lambda); step(mu) }
}

// Trace each component's outline directly from the partition's shared cell edges
// (NOT per-mask contouring). Every cell is a unit square centred on its grid node;
// a boundary segment is emitted wherever a cell meets a different region (or the
// masked-out exterior, -1). Edges are walked CW (interior on the right) into closed
// loops. Because borders are literal shared cell edges and junctions are exact cell
// corners, neighbouring sectors share the SAME segments and meet at a single point
// — no per-mask triangles at triple points. Returns Map regionId → [ring,…] (grid
// corner coords, each ring closed). Only true 4-way checkerboard corners are
// ambiguous; there we take the tightest right turn to keep interior-on-right.
function traceCellPolygons(comp, gw, gh) {
  const region = (r, c) => (r >= 0 && r < gh && c >= 0 && c < gw) ? comp[r * gw + c] : -1
  const byRegion = new Map()
  const add = (g, e) => { (byRegion.get(g) ?? byRegion.set(g, []).get(g)).push(e) }

  for (let r = 0; r < gh; r++) {
    for (let c = 0; c < gw; c++) {
      const g = region(r, c)
      if (g < 0) continue
      const x0 = c - 0.5, x1 = c + 0.5, y0 = r - 0.5, y1 = r + 0.5
      if (region(r - 1, c) !== g) add(g, [[x0, y0], [x1, y0]])   // top    TL→TR
      if (region(r, c + 1) !== g) add(g, [[x1, y0], [x1, y1]])   // right  TR→BR
      if (region(r + 1, c) !== g) add(g, [[x1, y1], [x0, y1]])   // bottom BR→BL
      if (region(r, c - 1) !== g) add(g, [[x0, y1], [x0, y0]])   // left   BL→TL
    }
  }

  // tightest right (clockwise, y-down screen) turn from incoming dir; avoids U-turns
  const pickNext = (din, cands, edges) => {
    let best = cands[0], bestCw = -1
    for (const j of cands) {
      const e = edges[j], d = [e[1][0] - e[0][0], e[1][1] - e[0][1]]
      const ang = Math.atan2(din[0] * d[1] - din[1] * d[0], din[0] * d[0] + din[1] * d[1])
      let cw = (-ang + 2 * Math.PI) % (2 * Math.PI)        // 0 = straight, π/2 = right, 3π/2 = left
      if (cw > Math.PI - 1e-6) cw -= 2 * Math.PI            // push U-turns to the back
      if (cw > bestCw) { bestCw = cw; best = j }
    }
    return best
  }

  const out = new Map()
  for (const [g, edges] of byRegion) {
    const from = new Map()   // start-corner vKey → unused edge indices
    edges.forEach((e, i) => {
      const k = vKey(e[0][0], e[0][1])
      ;(from.get(k) ?? from.set(k, []).get(k)).push(i)
    })
    const used = new Array(edges.length).fill(false)
    const rings = []
    for (let s = 0; s < edges.length; s++) {
      if (used[s]) continue
      const ring = []
      let ei = s
      while (ei != null && !used[ei]) {
        used[ei] = true
        const e = edges[ei]
        ring.push(e[0])
        const cands = (from.get(vKey(e[1][0], e[1][1])) ?? []).filter((j) => !used[j])
        ei = cands.length === 0 ? null
           : cands.length === 1 ? cands[0]
           : pickNext([e[1][0] - e[0][0], e[1][1] - e[0][1]], cands, edges)
      }
      ring.push(ring[0])
      if (ring.length >= 4) rings.push(ring)
    }
    out.set(g, rings)
  }
  return out
}

// ── Trace all sectors and smooth the shared boundary graph ───────────────────
function traceSectors(grid, comp, nComp) {
  const { cellMva, gw, gh, lonMin, latMax, gDegLat, gDegLon } = grid
  const r4   = (v) => Math.round(v * 1e4) / 1e4
  const toLL = ([x, y]) => [r4(lonMin + x * gDegLon), r4(latMax - y * gDegLat)]

  // value (max raw cell MVA) per component
  const value = new Float64Array(nComp)
  for (let i = 0; i < gw * gh; i++) {
    if (comp[i] < 0) continue
    if (cellMva[i] > value[comp[i]]) value[comp[i]] = cellMva[i]
  }

  // 1. Trace components into shared-edge polygons + build the boundary graph.
  const polysByRegion = traceCellPolygons(comp, gw, gh)
  const pos  = new Map()   // vKey → mutable [x,y] (shared across sectors)
  const nbrs = new Map()   // vKey → Set of neighbour vKeys
  for (const rings of polysByRegion.values()) {
    for (const ring of rings) {
      const n = ring.length - 1                 // last vertex repeats the first
      for (let i = 0; i < n; i++) {
        const k = vKey(ring[i][0], ring[i][1])
        if (!pos.has(k))  pos.set(k, [ring[i][0], ring[i][1]])
        if (!nbrs.has(k)) nbrs.set(k, new Set())
        const prev = ring[(i - 1 + n) % n], next = ring[(i + 1) % n]
        nbrs.get(k).add(vKey(prev[0], prev[1]))
        nbrs.get(k).add(vKey(next[0], next[1]))
      }
    }
  }

  // 2. Smooth the shared graph once (welded → no gaps, junctions pinned sharp).
  smoothShared(pos, nbrs, SMOOTH_ITERS, TAUBIN_LAMBDA, TAUBIN_MU)

  // 3. Rebuild each sector; largest ring = outer, the rest are holes.
  const sectors = []
  for (const [c, rings] of polysByRegion) {
    const alt = roundUp100(value[c])
    const ll  = rings
      .map((ring) => ring.map(([x, y]) => toLL(pos.get(vKey(x, y)))))
      .map((ring) => ({ ring, area: ringAreaNm2(ring) }))
      .filter((r) => r.area >= MIN_AREA_NM2)
      .sort((a, b) => b.area - a.area)
    if (!ll.length) continue
    const outRings = ll.map((r) => r.ring)
    const labelPt  = polylabel(outRings, 0.001)
    sectors.push({
      alt,
      labelPt: [snap01(labelPt[0]), snap01(labelPt[1])],
      rings:   outRings,
    })
  }
  return sectors
}

// ── MVA preview ramp (ft → [r,g,b]) ──────────────────────────────────────────
const RAMP = [
  [    0, [ 30,  60,  90]],
  [ 3000, [ 60, 130,  90]],
  [ 6000, [200, 200, 120]],
  [ 9000, [200, 130,  70]],
  [13000, [180,  80,  70]],
  [16000, [240, 240, 250]],
]
function rampColor(ft) {
  if (ft <= RAMP[0][0]) return RAMP[0][1]
  if (ft >= RAMP[RAMP.length - 1][0]) return RAMP[RAMP.length - 1][1]
  for (let i = 1; i < RAMP.length; i++) {
    if (ft <= RAMP[i][0]) {
      const [a, ca] = RAMP[i - 1], [b, cb] = RAMP[i]
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

// ── Facility source ───────────────────────────────────────────────────────────
// The controllable facilities (the ones that can hold a controller position) are
// the DCS airbases, enumerated per theatre in client/public/icaoMapping.json
// (DCS name → ICAO). NOT sectors.json (that is only airports with COM freqs, so
// it misses fields like OMDM). Coordinates are resolved per facility through a
// chain, since no single offline file has both ICAO and position for every field:
//   1. runways/<Theatre>.json — DCS-accurate runway geometry, keyed by DCS name
//   2. sectors.json           — by ICAO (COM airports)
//   3. LNM airport table      — by ICAO (optional; only if the source DB is present)

// Global DCS-name → {lat,lon} index over every runways/*.json (airport center =
// mean of its runway reference points).
function buildRunwayIndex() {
  const idx = {}
  let files
  try { files = fs.readdirSync(RUNWAYS_DIR).filter((f) => f.endsWith('.json')) } catch { return idx }
  for (const f of files) {
    let j
    try { j = JSON.parse(fs.readFileSync(path.join(RUNWAYS_DIR, f), 'utf8')) } catch { continue }
    for (const ab of j.airbases ?? []) {
      let sumLat = 0, sumLon = 0, n = 0
      for (const rw of Array.isArray(ab.runways) ? ab.runways : []) {
        let lat = rw.lat, lon = rw.lon
        if (lat == null && rw.end1 && rw.end2) { lat = (rw.end1.lat + rw.end2.lat) / 2; lon = (rw.end1.lon + rw.end2.lon) / 2 }
        if (lat == null || lon == null) continue
        sumLat += lat; sumLon += lon; n++
      }
      if (n && !(ab.airbase in idx)) idx[ab.airbase] = { lat: sumLat / n, lon: sumLon / n }
    }
  }
  return idx
}

// lowercased theatre key (matching icaoMapping's keys) → theatres.json folder/name
function theatreFolders(theatres) {
  const map = {}
  for (const [name, conf] of Object.entries(theatres)) map[name.toLowerCase()] = { name, folder: conf.folder }
  return map
}

// ── Driver ────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No elevation DB at ${DB_PATH}\nRun: node server/scripts/buildElevationDb.js`)
    process.exit(1)
  }
  if (!fs.existsSync(ICAOMAP_PATH)) {
    console.error(`No icaoMapping.json at ${ICAOMAP_PATH}`)
    process.exit(1)
  }

  const theatres = JSON.parse(fs.readFileSync(THEATRES_PATH, 'utf8'))
  const icaoMap  = JSON.parse(fs.readFileSync(ICAOMAP_PATH, 'utf8'))
  const sectors  = fs.existsSync(SECTORS_PATH) ? JSON.parse(fs.readFileSync(SECTORS_PATH, 'utf8')) : {}
  const rwIndex  = buildRunwayIndex()
  const folders  = theatreFolders(theatres)

  // Optional LNM coordinate fallback (the 235 MB navdata source DB).
  let lnm = null, lnmStmt = null
  if (LNM_DB_PATH && fs.existsSync(LNM_DB_PATH)) {
    try { lnm = new Database(LNM_DB_PATH, { readonly: true }); lnmStmt = lnm.prepare('SELECT laty, lonx FROM airport WHERE ident = ?') } catch { lnm = null }
  }

  const resolveCoords = (name, icao) => {
    if (rwIndex[name]) return { ...rwIndex[name], src: 'rwy' }
    if (sectors[icao]) return { lat: sectors[icao].lat, lon: sectors[icao].lon, src: 'sct' }
    if (lnmStmt) { const r = lnmStmt.get(icao); if (r) return { lat: r.laty, lon: r.lonx, src: 'lnm' } }
    return null
  }

  // Flat worklist of every controllable facility, with theatre + resolved coords.
  const worklist = []
  const unresolved = []
  for (const [tKey, fields] of Object.entries(icaoMap)) {
    if (tKey === '_note') continue
    const folder = folders[tKey]
    if (!folder) { console.log(`(theatre "${tKey}" not in theatres.json - skipped)`); continue }
    for (const [name, icao] of Object.entries(fields)) {
      const c = resolveCoords(name, icao)
      if (!c) { unresolved.push(`${icao}(${name})`); continue }
      worklist.push({ icao, name, lat: c.lat, lon: c.lon, src: c.src, folder: folder.folder, theatre: folder.name })
    }
  }

  // CLI filter: an ICAO, or a theatre (folder/name, case-insensitive).
  // Strip --lnm-path/<value> first so it doesn't shift this positional arg.
  const cliArgs = process.argv.slice(2)
  if (lnmArgIdx !== -1) cliArgs.splice(cliArgs.indexOf('--lnm-path'), 2)
  const arg = cliArgs[0]
  let jobs = worklist
  if (arg) {
    const up = arg.toUpperCase(), lo = arg.toLowerCase()
    const byIcao = worklist.filter((f) => f.icao.toUpperCase() === up)
    const byTheatre = worklist.filter((f) => f.theatre.toLowerCase() === lo || f.folder.toLowerCase() === lo)
    if (byIcao.length) jobs = byIcao
    else if (byTheatre.length) jobs = byTheatre
    else {
      console.error(`"${arg}" matched no controllable ICAO or theatre.`)
      if (lnm) lnm.close()
      process.exit(1)
    }
  }

  fs.mkdirSync(PREVIEW_DIR, { recursive: true })
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })

  console.log(`\nBuilding MVA - ${jobs.length} fac/ies · R=${R_NM} G=${G_NM} T=${T_FT}ft\n`)

  let built = 0
  const written = new Set()
  for (const fac of jobs) {
    const center  = { lat: fac.lat, lon: fac.lon }
    const cosLat  = Math.cos(center.lat * D2R)
    const rDegLat = R_NM / 60, rDegLon = R_NM / 60 / cosLat
    const bbox = [center.lon - rDegLon, center.lat - rDegLat, center.lon + rDegLon, center.lat + rDegLat]

    const mosaic = buildMosaic(db, bbox)
    const grid   = buildCellGrid(mosaic, center)
    const { comp, nComp } = absorbSmall(grid)
    const out = traceSectors(grid, comp, nComp)

    writeBMP(path.join(PREVIEW_DIR, `${fac.icao}.bmp`), grid.gw, grid.gh,
      (x, y) => grid.inMask[y * grid.gw + x] ? rampColor(grid.cellMva[y * grid.gw + x]) : [10, 12, 16])

    const outDir = path.join(CACHE_DIR, fac.folder, 'mva')
    fs.mkdirSync(outDir, { recursive: true })
    const outPath = path.join(outDir, `${fac.icao.toUpperCase()}.json`)
    fs.writeFileSync(outPath, JSON.stringify(out))
    written.add(path.resolve(outPath))

    const alts = out.map((s) => s.alt)
    console.log(
      `${fac.icao.padEnd(6)} ${fac.theatre.padEnd(14)} ${fac.src} · ` +
      `cells=${String(grid.nIn).padStart(4)} · ${String(out.length).padStart(3)} sectors · ` +
      `${alts.length ? Math.min(...alts) : 0}–${alts.length ? Math.max(...alts) : 0}ft · tiles ${mosaic.tilesFound}`
    )
    built++
  }

  db.close()
  if (lnm) lnm.close()

  // On a full build, prune stale mva/*.json this run didn't write — orphans from
  // an ICAO that moved theatres or left the controllable set would otherwise
  // shadow the fresh copy (handleMva returns the first folder match).
  let pruned = 0
  if (!arg) {
    for (const { folder } of Object.values(folders)) {
      const md = path.join(CACHE_DIR, folder, 'mva')
      if (!fs.existsSync(md)) continue
      for (const f of fs.readdirSync(md)) {
        if (!f.endsWith('.json')) continue
        const fp = path.join(md, f)
        if (!written.has(path.resolve(fp))) { fs.unlinkSync(fp); pruned++ }
      }
    }
  }

  console.log(`\nDone - ${built} built${pruned ? `, ${pruned} stale pruned` : ''}.` +
    (unresolved.length && !arg ? `  ${unresolved.length} unresolved (no coords): ${unresolved.join(', ')}` : '') +
    `\nPreviews → ${PREVIEW_DIR}\n`)
}

main().catch((err) => { console.error(err); process.exit(1) })
