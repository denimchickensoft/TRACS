'use strict'

// Builds per-theatre map-context overlays (roads, rail, water) and writes:
//   server/navdata/cache/<folder>/mapcontext.json
//
// Roads/rail: pre-filtered from Geofabrik .osm.pbf country extracts by
// server/scripts/extract_osm_roads.py (run that first - see its docstring).
// This replaced live Overpass API queries (see abm-map-context-spec.md §5
// items 5-6): one big per-theatre Overpass request was unreliable (406s,
// 504s, hangs), and even tiling into small chunks still means many requests
// against a shared live query service - a one-time bulk download from
// Geofabrik's static file host is a fundamentally gentler pattern, and is
// what's used now.
//
// Water: Natural Earth rivers/lakes (same source + pattern as
// buildGeoData.js's boundaries/coastlines) - no query API, no rate limits,
// downloaded once and cached in server/data/geo/ alongside the existing
// boundary/coastline source files.
//
// Usage:
//   python server/scripts/extract_osm_roads.py     # once, or when adding a new region
//   node server/scripts/buildRoadsWaterData.js            # all theatres
//   node server/scripts/buildRoadsWaterData.js Syria       # one theatre
//
// Data © OpenStreetMap contributors (ODbL) / Natural Earth (public domain) —
// OSM attribution must be shown wherever roads/rail are rendered.

const https = require('https')
const http  = require('http')
const fs    = require('fs')
const path  = require('path')
const { simplifyAndRound } = require('./lib/simplify.js')

const THEATRES_PATH = path.join(__dirname, '../navdata/config/theatres.json')
const CACHE_DIR      = path.join(__dirname, '../navdata/cache')
const GEO_DIR         = path.join(__dirname, '../data/geo') // shared with buildGeoData.js
const OSM_BUILD_DIR   = path.join(__dirname, '../../resources/osm-build')
const ROADS_RAIL_RAW_DIR = path.join(OSM_BUILD_DIR, 'roads_rail_raw')
const TOWNS_DIR       = path.join(__dirname, '../../client/public/towns')

// theatres.json bboxes are padded generously for relief/geo (sea, distant
// neighbouring territory) - clipping roads/rail/water to that directly pulls
// in huge irrelevant chunks of adjacent countries (e.g. most of Turkey, for
// Syria). Where a theatre has town-label data (server/scripts/buildTownLabels.js
// output), its bbox is a much tighter, DCS-accurate stand-in for the real
// playable map extent - mission designers don't place town labels outside
// the map. Fall back to the theatres.json bbox (unshrunk) when no towns data
// exists (Nevada, Kola, etc. - which are also self-contained, single-country
// maps, so the over-inclusion problem is much smaller there anyway).
const CLIP_PAD_DEG = 0.5

function deriveClipBbox(theatreName, fallbackBbox) {
  const townsPath = path.join(TOWNS_DIR, `${theatreName}.json`)
  if (!fs.existsSync(townsPath)) return fallbackBbox
  const { towns } = JSON.parse(fs.readFileSync(townsPath, 'utf8'))
  if (!towns || !towns.length) return fallbackBbox
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
  for (const t of towns) {
    if (t.lon < minLon) minLon = t.lon
    if (t.lon > maxLon) maxLon = t.lon
    if (t.lat < minLat) minLat = t.lat
    if (t.lat > maxLat) maxLat = t.lat
  }
  return [minLon - CLIP_PAD_DEG, minLat - CLIP_PAD_DEG, maxLon + CLIP_PAD_DEG, maxLat + CLIP_PAD_DEG]
}

const NE_WATER_SOURCES = {
  rivers: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_rivers_lake_centerlines.geojson',
  lakes:  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_lakes.geojson',
}

// ── Natural Earth fetch (water) ──────────────────────────────────────────────

function fetchUrl(url, depth = 0) {
  if (depth > 5) return Promise.reject(new Error('Too many redirects'))
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
        return resolve(fetchUrl(res.headers.location, depth + 1))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      res.on('error', reject)
    })
    req.on('error', reject)
  })
}

async function loadNeSource(key) {
  fs.mkdirSync(GEO_DIR, { recursive: true })
  const localPath = path.join(GEO_DIR, `${key}.geojson`)
  if (fs.existsSync(localPath)) {
    process.stdout.write(`  ${key}: using cached copy\n`)
    return JSON.parse(fs.readFileSync(localPath, 'utf8')).features
  }
  process.stdout.write(`  ${key}: downloading from Natural Earth…`)
  const raw = await fetchUrl(NE_WATER_SOURCES[key])
  fs.writeFileSync(localPath, raw)
  process.stdout.write(' done\n')
  return JSON.parse(raw).features
}

// ── Geometry helpers (bbox clip) ─────────────────────────────────────────────

function bboxOf(coords) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
  for (const [lon, lat] of coords) {
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }
  return [minLon, minLat, maxLon, maxLat]
}

function bboxIntersects(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
}

const BBOX_PAD = 1.0

function paddedBbox(theatreBbox) {
  const [tMinLon, tMinLat, tMaxLon, tMaxLat] = theatreBbox
  return [tMinLon - BBOX_PAD, tMinLat - BBOX_PAD, tMaxLon + BBOX_PAD, tMaxLat + BBOX_PAD]
}

// ── Simplification ────────────────────────────────────────────────────────────
// This is a broad-SA reference layer, not a precision instrument - full OSM
// vertex density and coordinate precision is far more than needed. Both
// levers below (lib/simplify.js) are visually lossless at ABM's overview zoom
// levels but cut output size drastically (coordinate arrays are ~100% of
// file size: see abm-map-context-spec.md, ~4.5M points measured at ~25
// bytes/point = the entire 113MB before this was added).

function clipWaterFeatures(features, theatreBbox, type) {
  const padded = paddedBbox(theatreBbox)
  const out = []
  for (const feat of features) {
    const geom = feat.geometry
    if (!geom) continue
    const rings = geom.type === 'LineString'      ? [geom.coordinates]
                : geom.type === 'MultiLineString' ? geom.coordinates
                : geom.type === 'Polygon'         ? geom.coordinates
                : geom.type === 'MultiPolygon'    ? geom.coordinates.flat()
                : []
    for (const coords of rings) {
      const bbox = bboxOf(coords)
      if (!bboxIntersects(bbox, padded)) continue
      out.push({ coords: simplifyAndRound(coords), type, name: feat.properties?.name || null })
    }
  }
  return out
}

// ── Roads/rail (pre-filtered Geofabrik data) ─────────────────────────────────

// Streams through the per-country raw files one at a time and filters
// immediately, instead of concatenating all countries into one big live
// array first (the previous approach - simple, but holding ~5.4M parsed
// feature objects at once exceeded Node's heap once Germany's 6-country
// batch pushed the total that high; crashed at ~4.2GB). Only one country's
// parsed features are ever live at a time here, so peak memory is bounded
// by the single largest country file, not the sum of all of them. Costs a
// fresh read+parse of every country file per theatre (no cross-theatre
// cache), which is slower for a full "all theatres" run but no longer a
// correctness problem.
function clipRoadsRail(theatreBbox) {
  if (!fs.existsSync(ROADS_RAIL_RAW_DIR)) {
    throw new Error(
      `${ROADS_RAIL_RAW_DIR} not found. Run "python server/scripts/extract_osm_roads.py" first.`
    )
  }
  const padded = paddedBbox(theatreBbox)
  const files  = fs.readdirSync(ROADS_RAIL_RAW_DIR).filter(f => f.endsWith('.json'))
  const roads = []
  const rail  = []
  let total = 0
  for (const file of files) {
    const { features } = JSON.parse(fs.readFileSync(path.join(ROADS_RAIL_RAW_DIR, file), 'utf8'))
    total += features.length
    for (const f of features) {
      if (!f.coords || f.coords.length < 2) continue
      const bbox = bboxOf(f.coords)
      if (!bboxIntersects(bbox, padded)) continue
      const coords = simplifyAndRound(f.coords)
      if (f.railway) {
        rail.push({ coords, name: f.name || null })
      } else if (f.class) {
        roads.push({ coords, class: f.class, name: f.name || null })
      }
    }
  }
  process.stdout.write(`  scanned ${total} features across ${files.length} countries\n`)
  return { roads, rail }
}

// ── Driver ────────────────────────────────────────────────────────────────────

async function buildTheatre(name, conf, opts) {
  const t0 = process.hrtime.bigint()
  console.log(`${name}:`)

  const clipBbox = deriveClipBbox(name, conf.bbox)

  let roads = [], rail = []
  if (!opts.waterOnly) {
    ;({ roads, rail } = clipRoadsRail(clipBbox))
  }

  const [riverFeatures, lakeFeatures] = await Promise.all([
    loadNeSource('rivers'),
    loadNeSource('lakes'),
  ])
  const water = [
    ...clipWaterFeatures(riverFeatures, clipBbox, 'river'),
    ...clipWaterFeatures(lakeFeatures, clipBbox, 'lake'),
  ]

  const outDir = path.join(CACHE_DIR, conf.folder)
  fs.mkdirSync(outDir, { recursive: true })
  const existingPath = path.join(outDir, 'mapcontext.json')

  let payload = { attribution: '© OpenStreetMap contributors (ODbL)', roads, rail, water }
  if (opts.waterOnly && fs.existsSync(existingPath)) {
    const existing = JSON.parse(fs.readFileSync(existingPath, 'utf8'))
    payload = { ...existing, water }
  }

  const json = JSON.stringify(payload)
  fs.writeFileSync(existingPath, json)

  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  const kb = (json.length / 1024).toFixed(1)
  console.log(
    `  -> ${String(payload.roads.length).padStart(5)} roads  ` +
    `${String(payload.rail.length).padStart(4)} rail  ` +
    `${String(payload.water.length).padStart(4)} water  ` +
    `${kb.padStart(8)} KB  ·  ${(ms/1000).toFixed(1)}s\n`
  )
}

async function main() {
  const theatres = JSON.parse(fs.readFileSync(THEATRES_PATH, 'utf8'))
  const args = process.argv.slice(2)
  const waterOnly = args.includes('--water-only')
  const only = args.find((a) => !a.startsWith('--'))

  if (only && !theatres[only]) {
    console.error(`Unknown theatre "${only}". Options: ${Object.keys(theatres).join(', ')}`)
    process.exit(1)
  }

  console.log(`\nBuilding map-context data${waterOnly ? ' (water only, Natural Earth)' : ' (Geofabrik roads/rail + Natural Earth water)'}\n`)

  const entries = only ? [[only, theatres[only]]] : Object.entries(theatres)
  for (const [name, conf] of entries) {
    await buildTheatre(name, conf, { waterOnly })
  }

  console.log('Done.\n')
}

main().catch((err) => { console.error(err); process.exit(1) })
