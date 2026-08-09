'use strict'

// Renders a proof-sheet PNG per theatre from airports_polygons.json — one
// tile per airport (taxiway centerlines + runway footprint), labeled with
// display name, ICAO code, and runway designator pair(s). Documentation
// output only (resources/airports/), not consumed by the app.
//
// Same "no image-library deps for build tooling" approach as
// buildAbmBasemap.js: hand-rolled rasterizer (rasterCore.js) + hand-rolled
// PNG encoder (pngEncoder.js) + hand-rolled 5x7 font (pixelFont.js).
//
// Usage:
//   node server/scripts/buildAirportPreviews.js            # all theatres
//   node server/scripts/buildAirportPreviews.js Caucasus   # one theatre

const fs   = require('fs')
const path = require('path')
const { encodePNG } = require('./lib/pngEncoder.js')
const { fillPolygonEvenOdd, blendPixel } = require('./lib/rasterCore.js')
const { drawText, measureText } = require('./lib/pixelFont.js')

const ROOT         = path.join(__dirname, '../..')
const CACHE_DIR    = path.join(__dirname, '../navdata/cache')
const RUNWAYS_DIR  = path.join(ROOT, 'client/public/runways')
const OUT_DIR       = path.join(ROOT, 'resources/airports')
const THEATRES     = JSON.parse(fs.readFileSync(path.join(__dirname, '../navdata/config/theatres.json'), 'utf8'))
const NAME_MAP     = JSON.parse(fs.readFileSync(path.join(__dirname, '../navdata/config/airport_name_map.json'), 'utf8'))
const ICAO_MAP     = JSON.parse(fs.readFileSync(path.join(ROOT, 'client/public/icaoMapping.json'), 'utf8'))

// ── Layout ────────────────────────────────────────────────────────────────
const TILE_MAP   = 380 // square drawing area for the airport diagram, px
const TILE_PAD   = 16
const LABEL_H    = 60
const TILE_W     = TILE_MAP + TILE_PAD * 2
const TILE_H     = TILE_MAP + LABEL_H + TILE_PAD * 2
const GAP        = 20
const HEADER_H   = 64

// Everything fits on one image per theatre — pick cols/rows so the page
// comes out close to square instead of a fixed column count (which, at 4
// wide, made Germany's 119 airports absurdly tall). Try every column count
// from 1..n, keep the one whose resulting page has the smallest width:height
// ratio deviation from 1; ties broken by fewest empty trailing slots.
function chooseGrid(n) {
  let best = null
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols)
    const width  = GAP + cols * (TILE_W + GAP)
    const height = HEADER_H + GAP + rows * (TILE_H + GAP)
    const squareness = Math.max(width, height) / Math.min(width, height)
    const waste = cols * rows - n
    if (!best || squareness < best.squareness || (squareness === best.squareness && waste < best.waste)) {
      best = { cols, rows, squareness, waste }
    }
  }
  return { cols: best.cols, rows: best.rows }
}

const BG_COLOR       = [24, 26, 22]
const TILE_BG        = [36, 39, 34]
const TILE_BORDER    = [70, 74, 66]
const TAXIWAY_COLOR  = [140, 145, 130]
const RUNWAY_COLOR   = [245, 245, 240]
const TITLE_COLOR    = [235, 235, 225]
const NAME_COLOR     = [235, 235, 225]
const ICAO_COLOR     = [235, 200, 90]

function readJson(p) {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null
}

function newBuffer(width, height, bgColor) {
  const buf = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    buf[i * 4] = bgColor[0]; buf[i * 4 + 1] = bgColor[1]; buf[i * 4 + 2] = bgColor[2]; buf[i * 4 + 3] = 255
  }
  return buf
}

function fillRect(buf, width, height, x0, y0, w, h, color) {
  const x1 = Math.min(width, x0 + w), y1 = Math.min(height, y0 + h)
  for (let y = Math.max(0, y0); y < y1; y++) {
    for (let x = Math.max(0, x0); x < x1; x++) blendPixel(buf, (y * width + x) * 4, color[0], color[1], color[2], 1)
  }
}

function strokeRect(buf, width, height, x0, y0, w, h, color) {
  for (let x = x0; x < x0 + w; x++) {
    blendPixel(buf, (y0 * width + x) * 4, color[0], color[1], color[2], 1)
    blendPixel(buf, ((y0 + h - 1) * width + x) * 4, color[0], color[1], color[2], 1)
  }
  for (let y = y0; y < y0 + h; y++) {
    blendPixel(buf, (y * width + x0) * 4, color[0], color[1], color[2], 1)
    blendPixel(buf, (y * width + x0 + w - 1) * 4, color[0], color[1], color[2], 1)
  }
}

function centeredText(buf, width, height, cx, y0, text, scale, color) {
  const w = measureText(text, scale)
  drawText(buf, width, height, Math.round(cx - w / 2), y0, text, scale, color[0], color[1], color[2], 1, blendPixel)
}

// Display-only trim — "Airport"/"Airbase"/"Air Base"/"Airfield" add no info on
// a tile that's already a runway diagram; "AFB" stays since it reads as part
// of the name. "International" is abbreviated to "Intl" rather than dropped,
// since unlike the others it's not implied by the tile itself. Only affects
// the drawn label — airport.name itself (ICAO/runway lookups) is untouched.
function displayLabel(name) {
  // A couple of raw DCS names carry an underscore instead of a space (e.g.
  // "Quasoura_airport") — normalize first so \b word boundaries below still
  // catch "Airport" as its own word instead of being glued to the prior one.
  return name
    .replace(/_/g, ' ')
    .replace(/\bAir\s*Base\b/gi, '')
    .replace(/\bAirport\b/gi, '')
    .replace(/\bAirfield\b/gi, '')
    .replace(/\bInternational\b/gi, 'Intl')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// Runway JSON only records one designator per physical strip; the reciprocal
// end (e.g. 22 -> 04) is the same strip's other threshold, +180deg / 18 tens.
function reciprocal(designator) {
  let r = designator + 18
  if (r > 36) r -= 36
  if (r <= 0) r += 36
  return r
}
const two = (n) => String(n).padStart(2, '0')

// A handful of rn5 taxiway stems carry one corrupted vertex thousands of km
// from the rest of the airport (seen in Germany's Buchel and South Atlantic's
// AlmiranteSchroeders) — a plain min/max bbox lets that single point blow the
// scale out until the real geometry collapses to sub-pixel. Median-filter
// first so an isolated outlier can't dominate; real airport geometry never
// spans more than ~0.1deg (~10km), so anything farther than that from the
// median point is bad data. Also used at draw time (isOutlierPoint) to skip
// the corrupted ring entirely — every tile shares one page-sized pixel
// buffer, so a stray vertex that far off just projects to a huge pixel
// offset and paints a streak across whatever tile happens to sit in the way.
const OUTLIER_DEG = 0.1
function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
function robustBbox(features) {
  const points = []
  for (const f of features) for (const pt of f.geometry.coordinates[0]) points.push(pt)

  const medianLon = median(points.map((p) => p[0]))
  const medianLat = median(points.map((p) => p[1]))
  const inlierPoints = points.filter(([lon, lat]) =>
    Math.abs(lon - medianLon) <= OUTLIER_DEG && Math.abs(lat - medianLat) <= OUTLIER_DEG)
  const use = inlierPoints.length ? inlierPoints : points

  let lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity
  for (const [lon, lat] of use) {
    if (lon < lonMin) lonMin = lon
    if (lon > lonMax) lonMax = lon
    if (lat < latMin) latMin = lat
    if (lat > latMax) latMax = lat
  }
  return { lonMin, lonMax, latMin, latMax, medianLon, medianLat }
}

function loadTheatreAirports(theatreKey) {
  const conf = THEATRES[theatreKey]
  if (!conf) return null
  const polyPath = path.join(CACHE_DIR, conf.folder, 'airports_polygons.json')
  if (!fs.existsSync(polyPath)) return null

  const polyData = JSON.parse(fs.readFileSync(polyPath, 'utf8'))
  const nameMap  = NAME_MAP[theatreKey] || {}
  const icaoMap  = ICAO_MAP[theatreKey.toLowerCase()] || {}

  const rwPath = path.join(RUNWAYS_DIR, `${conf.runwayKey || theatreKey}.json`)
  const rwJson = readJson(rwPath)
  const rwByName = new Map()
  for (const ab of (rwJson && rwJson.airbases) || []) {
    rwByName.set(ab.airbase, Array.isArray(ab.runways) ? ab.runways : [])
  }

  const byAirport = new Map()
  for (const feature of polyData.features) {
    const key = feature.properties.airport
    if (!byAirport.has(key)) byAirport.set(key, [])
    byAirport.get(key).push(feature)
  }

  const airports = []
  for (const [rawKey, features] of byAirport) {
    const name = nameMap[rawKey] || rawKey
    const icao = icaoMap[name] || '----'
    // Parallel runways (e.g. 13L/31R + 13R/31L) share a numeric designator pair —
    // the source data has no L/R suffix, so dedupe to avoid printing "13/31 31/13".
    const runways = [...new Set((rwByName.get(name) || []).map((rw) => {
      const a = rw.name, b = reciprocal(rw.name)
      return `${two(Math.min(a, b))}/${two(Math.max(a, b))}`
    }))]

    const { lonMin, lonMax, latMin, latMax, medianLon, medianLat } = robustBbox(features)

    // Skip airports with no correlated runway — see feedback_airport_runway_correlation:
    // these aren't selectable TRACS facilities (Login.jsx filters the same way), and a
    // lot of them are real fixed-wing fields whose runway just isn't exposed via the API
    // yet, not helipads/heliports — drawing them with a "HELIPAD" label was actively wrong.
    if (runways.length === 0) continue

    airports.push({ name, icao, runways, features, lonMin, lonMax, latMin, latMax, medianLon, medianLat })
  }

  airports.sort((a, b) => a.name.localeCompare(b.name))
  return airports
}

function drawAirportTile(buf, width, height, tx, ty, airport) {
  fillRect(buf, width, height, tx, ty, TILE_W, TILE_H, TILE_BG)
  strokeRect(buf, width, height, tx, ty, TILE_W, TILE_H, TILE_BORDER)

  const mapX0 = tx + TILE_PAD, mapY0 = ty + TILE_PAD
  const lonMid = (airport.lonMin + airport.lonMax) / 2
  const latMid = (airport.latMin + airport.latMax) / 2
  const cosLat = Math.cos((latMid * Math.PI) / 180)

  let xExt = (airport.lonMax - airport.lonMin) * cosLat
  let yExt = airport.latMax - airport.latMin
  if (xExt <= 0) xExt = 0.0005
  if (yExt <= 0) yExt = 0.0005

  const drawArea = TILE_MAP - 24 // inner padding so shapes don't touch the border
  const scale = Math.min(drawArea / xExt, drawArea / yExt)
  const cx = mapX0 + TILE_MAP / 2
  const cy = mapY0 + TILE_MAP / 2

  const project = ([lon, lat]) => {
    const x = (lon - lonMid) * cosLat * scale
    const y = (lat - latMid) * scale
    return [cx + x, cy - y]
  }

  const isOutlier = ([lon, lat]) =>
    Math.abs(lon - airport.medianLon) > OUTLIER_DEG || Math.abs(lat - airport.medianLat) > OUTLIER_DEG

  // Taxiways first, runway drawn on top so it reads clearly against the mesh.
  const taxiways = airport.features.filter((f) => f.properties.type === 'taxiway')
  const runwaysGeo = airport.features.filter((f) => f.properties.type === 'runway')
  for (const f of taxiways) {
    const raw = f.geometry.coordinates[0]
    if (raw.some(isOutlier)) continue // corrupted rn5 vertex — see robustBbox note above
    fillPolygonEvenOdd(buf, width, height, [raw.map(project)], ...TAXIWAY_COLOR, 0.9)
  }
  for (const f of runwaysGeo) {
    const raw = f.geometry.coordinates[0]
    if (raw.some(isOutlier)) continue
    fillPolygonEvenOdd(buf, width, height, [raw.map(project)], ...RUNWAY_COLOR, 1)
  }

  const labelY0 = mapY0 + TILE_MAP + 6
  const tileCx = tx + TILE_W / 2
  centeredText(buf, width, height, tileCx, labelY0, displayLabel(airport.name), 2, NAME_COLOR)
  const rwyText = `${airport.icao}  RWY ${airport.runways.join(' ')}`
  centeredText(buf, width, height, tileCx, labelY0 + 22, rwyText, 1, ICAO_COLOR)
}

function buildTheatrePage(theatreKey, airports) {
  const { cols, rows } = chooseGrid(airports.length)
  const width  = GAP + cols * (TILE_W + GAP)
  const height = HEADER_H + GAP + rows * (TILE_H + GAP)

  const buf = newBuffer(width, height, BG_COLOR)

  const theatreLabel = theatreKey.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase()
  centeredText(buf, width, height, width / 2, 22, `${theatreLabel} - AIRPORT DIAGRAMS`, 3, TITLE_COLOR)

  airports.forEach((airport, i) => {
    const col = i % cols, row = Math.floor(i / cols)
    const tx = GAP + col * (TILE_W + GAP)
    const ty = HEADER_H + GAP + row * (TILE_H + GAP)
    drawAirportTile(buf, width, height, tx, ty, airport)
  })

  return { buf, width, height }
}

function buildTheatre(theatreKey) {
  const conf = THEATRES[theatreKey]
  const airports = loadTheatreAirports(theatreKey)
  if (!airports) {
    console.log(`  ${theatreKey}: skipped — no airports_polygons.json`)
    return
  }

  const page = buildTheatrePage(theatreKey, airports)
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const outPath = path.join(OUT_DIR, `${conf.folder}.png`)
  const png = encodePNG(page.width, page.height, page.buf)
  fs.writeFileSync(outPath, png)
  console.log(`${theatreKey.padEnd(16)}  ${page.width}x${page.height}  ${(png.length / 1024).toFixed(0)} KB  -> ${path.relative(ROOT, outPath)}`)
}

function main() {
  const only = process.argv[2]
  if (only && !THEATRES[only]) {
    console.error(`Unknown theatre "${only}". Options: ${Object.keys(THEATRES).join(', ')}`)
    process.exit(1)
  }

  console.log('\nBuilding airport preview sheets\n')
  const theatres = only ? [only] : Object.keys(THEATRES)
  for (const t of theatres) buildTheatre(t)
  console.log('\nDone.\n')
}

main()
