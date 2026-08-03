'use strict'

// Builds per-theatre GEO overlays (country boundaries + coastlines) from
// Natural Earth 1:10m public-domain vector data. Downloads source GeoJSON
// once to server/data/geo/, then clips per theatre and writes:
//   server/navdata/cache/<folder>/geo.json
//
// Usage:
//   node server/scripts/buildGeoData.js            # all theatres
//   node server/scripts/buildGeoData.js Caucasus   # one theatre

const https  = require('https')
const http   = require('http')
const fs     = require('fs')
const path   = require('path')

const THEATRES_PATH = path.join(__dirname, '../navdata/config/theatres.json')
const CACHE_DIR     = path.join(__dirname, '../navdata/cache')
const GEO_DIR       = path.join(__dirname, '../data/geo')
const BBOX_PAD      = 1.0   // degrees — extend theatre bbox before clipping

const NE_SOURCES = {
  boundaries: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_boundary_lines_land.geojson',
  coastlines:  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_coastline.geojson',
  land:        'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson',
}

// ── HTTP fetch with redirect support ─────────────────────────────────────────

function fetch(url, depth = 0) {
  if (depth > 5) return Promise.reject(new Error('Too many redirects'))
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
        return resolve(fetch(res.headers.location, depth + 1))
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

// ── Geometry helpers ──────────────────────────────────────────────────────────

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

function extractSegments(features, theatreBbox) {
  const [tMinLon, tMinLat, tMaxLon, tMaxLat] = theatreBbox
  const padded = [tMinLon - BBOX_PAD, tMinLat - BBOX_PAD, tMaxLon + BBOX_PAD, tMaxLat + BBOX_PAD]
  const out = []
  for (const feat of features) {
    const geom = feat.geometry
    if (!geom) continue
    const lines = geom.type === 'LineString'      ? [geom.coordinates]
                : geom.type === 'MultiLineString' ? geom.coordinates
                : []
    for (const coords of lines) {
      const bbox = bboxOf(coords)
      if (!bboxIntersects(bbox, padded)) continue
      out.push({ coords, bbox })
    }
  }
  return out
}

// ── Land-polygon clipping ─────────────────────────────────────────────────────
// Unlike coastlines/boundaries (already pre-chunked by Natural Earth into
// thousands of modestly-sized features — max ~16.5k points each),
// ne_10m_land packs each connected landmass into a single giant ring: the
// Eurasia+Africa supercontinent alone is ~80k points. Whole-feature bbox
// filtering (extractSegments' approach) would keep that entire ring —
// including vertices on the opposite side of the planet — for every Old
// World theatre, and feeding vertices 90°+ from a regional TM's central
// meridian through tmForward risks numerically undefined output that
// corrupts fillPolygonEvenOdd's scanline fill (see 2026-08-03 discussion).
// So land rings get genuinely clipped to the padded theatre bbox here, in
// lat/lon space, before ever reaching the projection step — standard
// Sutherland–Hodgman against the (convex) rectangle, run once per axis.
function clipEdge(points, inside, intersect) {
  if (!points.length) return []
  const out = []
  const n = points.length
  for (let i = 0; i < n; i++) {
    const curr = points[i]
    const prev = points[(i - 1 + n) % n]
    const currIn = inside(curr)
    if (currIn !== inside(prev)) out.push(intersect(prev, curr))
    if (currIn) out.push(curr)
  }
  return out
}

function clipRingToBbox(ring, bbox) {
  const [xmin, ymin, xmax, ymax] = bbox
  let pts = ring
  pts = clipEdge(pts, p => p[0] >= xmin, (a, b) => [xmin, a[1] + (xmin - a[0]) * (b[1] - a[1]) / (b[0] - a[0])])
  pts = clipEdge(pts, p => p[0] <= xmax, (a, b) => [xmax, a[1] + (xmax - a[0]) * (b[1] - a[1]) / (b[0] - a[0])])
  pts = clipEdge(pts, p => p[1] >= ymin, (a, b) => [a[0] + (ymin - a[1]) * (b[0] - a[0]) / (b[1] - a[1]), ymin])
  pts = clipEdge(pts, p => p[1] <= ymax, (a, b) => [a[0] + (ymax - a[1]) * (b[0] - a[0]) / (b[1] - a[1]), ymax])
  return pts
}

// Every ring (outer boundaries and holes alike) clipped independently and
// handed back flat — fillPolygonEvenOdd doesn't need holes paired with their
// own outer ring, just the full set together in one call, since even-odd
// parity across disjoint real-world landmasses/holes works out the same
// either way (see 2026-08-03 discussion).
function extractLandRings(features, theatreBbox) {
  const [tMinLon, tMinLat, tMaxLon, tMaxLat] = theatreBbox
  const padded = [tMinLon - BBOX_PAD, tMinLat - BBOX_PAD, tMaxLon + BBOX_PAD, tMaxLat + BBOX_PAD]
  const out = []
  for (const feat of features) {
    const geom = feat.geometry
    if (!geom) continue
    const polys = geom.type === 'Polygon'      ? [geom.coordinates]
                : geom.type === 'MultiPolygon' ? geom.coordinates
                : []
    for (const rings of polys) {
      for (const ring of rings) {
        const bbox = bboxOf(ring)
        if (!bboxIntersects(bbox, padded)) continue
        const clipped = clipRingToBbox(ring, padded)
        if (clipped.length >= 3) out.push(clipped)
      }
    }
  }
  return out
}

// ── Source data loading (download once, cache locally) ────────────────────────

async function loadSource(key) {
  fs.mkdirSync(GEO_DIR, { recursive: true })
  const localPath = path.join(GEO_DIR, `${key}.geojson`)
  if (fs.existsSync(localPath)) {
    process.stdout.write(`  ${key}: using cached copy\n`)
    return JSON.parse(fs.readFileSync(localPath, 'utf8')).features
  }
  process.stdout.write(`  ${key}: downloading from Natural Earth…`)
  const raw = await fetch(NE_SOURCES[key])
  fs.writeFileSync(localPath, raw)
  process.stdout.write(' done\n')
  return JSON.parse(raw).features
}

// ── Driver ────────────────────────────────────────────────────────────────────

async function main() {
  const theatres = JSON.parse(fs.readFileSync(THEATRES_PATH, 'utf8'))
  const only = process.argv[2]
  if (only && !theatres[only]) {
    console.error(`Unknown theatre "${only}". Options: ${Object.keys(theatres).join(', ')}`)
    process.exit(1)
  }

  console.log('\nBuilding GEO data (Natural Earth 1:10m)\n')

  console.log('Source files:')
  const [boundaryFeatures, coastlineFeatures, landFeatures] = await Promise.all([
    loadSource('boundaries'),
    loadSource('coastlines'),
    loadSource('land'),
  ])
  console.log()

  const entries = only ? [[only, theatres[only]]] : Object.entries(theatres)

  for (const [name, conf] of entries) {
    const t0 = process.hrtime.bigint()
    const boundaries = extractSegments(boundaryFeatures, conf.bbox)
    const coastlines  = extractSegments(coastlineFeatures, conf.bbox)
    const land        = extractLandRings(landFeatures, conf.bbox)

    const outDir = path.join(CACHE_DIR, conf.folder)
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'geo.json'), JSON.stringify({ boundaries, coastlines, land }))

    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    const kb = (JSON.stringify({ boundaries, coastlines, land }).length / 1024).toFixed(1)
    console.log(
      `${name.padEnd(16)} ${String(boundaries.length).padStart(3)} boundaries  ` +
      `${String(coastlines.length).padStart(3)} coastlines  ` +
      `${String(land.length).padStart(3)} land rings  ` +
      `${kb.padStart(6)} KB  ·  ${ms.toFixed(0)}ms`
    )
  }

  console.log('\nDone.\n')
}

main().catch((err) => { console.error(err); process.exit(1) })
