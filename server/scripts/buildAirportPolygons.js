'use strict'

// Builds per-theatre airport surface polygon data for the ASDE-X module.
// For each theatre, reads DCS rn5 binary files (taxiway centerlines) and
// DCS runway JSON (authoritative runway endpoints), applies a two-layer
// superimposition approach, and writes:
//   server/navdata/cache/<folder>/airports_polygons.json
//
// Usage:
//   node server/scripts/buildAirportPolygons.js [theatre]
//   node server/scripts/buildAirportPolygons.js [--dcs-path <path>] [theatre]
//
// DCS terrain path defaults to the Steam installation. Override with --dcs-path.

const fs   = require('fs')
const path = require('path')

const ROOT         = path.join(__dirname, '../..')
const CACHE_DIR    = path.join(__dirname, '../navdata/cache')
const TM_PARAMS    = JSON.parse(fs.readFileSync(path.join(__dirname, '../navdata/config/airspace_tm_params.json'), 'utf8'))
const NAME_MAP     = JSON.parse(fs.readFileSync(path.join(__dirname, '../navdata/config/airport_name_map.json'), 'utf8'))
const THEATRES     = JSON.parse(fs.readFileSync(path.join(__dirname, '../navdata/config/theatres.json'), 'utf8'))

const DEFAULT_DCS_PATH = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\DCSWorld\\Mods\\terrains'

// Runway JSON filename differs from theatre key for some theatres
const RUNWAY_FILE = { Sinai: 'SinaiMap' }

const TAXIWAY_WIDTH_M = 22.0
const ZERO_8 = Buffer.alloc(8)

// ── Transverse Mercator inverse projection ────────────────────────────────────

function makeTmInv(p, latMin, latMax, lonMin, lonMax) {
  const a    = 6378137.0
  const f    = 1 / 298.257223563
  const e2   = 2 * f - f * f
  const k0   = p.scale_factor
  const lon0 = p.central_meridian * Math.PI / 180

  return function tmInv(easting, northing) {
    const x  = easting  - p.false_easting
    const y  = northing - p.false_northing
    const M  = y / k0
    const mu = M / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256))
    const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2))
    const lat1 = mu
      + (3 * e1 / 2 - 27 * e1 ** 3 / 32)  * Math.sin(2 * mu)
      + (21 * e1 ** 2 / 16)                * Math.sin(4 * mu)
      + (151 * e1 ** 3 / 96)               * Math.sin(6 * mu)
    const N1   = a / Math.sqrt(1 - e2 * Math.sin(lat1) ** 2)
    const T1   = Math.tan(lat1) ** 2
    const C1   = e2 / (1 - e2) * Math.cos(lat1) ** 2
    const R1   = a * (1 - e2) / (1 - e2 * Math.sin(lat1) ** 2) ** 1.5
    const D    = x / (N1 * k0)
    if (Math.abs(D) > 4) return null
    const lat = lat1 - (N1 * Math.tan(lat1) / R1) * (
      D ** 2 / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2) * D ** 4 / 24
    )
    const lon = lon0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6) / Math.cos(lat1)
    const la  = lat * 180 / Math.PI
    const lo  = lon * 180 / Math.PI
    if (la < latMin || la > latMax || lo < lonMin || lo > lonMax) return null
    return [la, lo]
  }
}

// ── rn5 binary segment extraction ────────────────────────────────────────────

function extractRn5(data, tmInv, nMin = 5, nMax = 300) {
  const segments = []
  let i = 0
  while (i < data.length - 28) {
    const n = data.readUInt32LE(i)
    if (n >= nMin && n <= nMax) {
      const nodes = []
      let valid = true
      for (let k = 0; k < n; k++) {
        const off = i + 4 + k * 24
        if (off + 24 > data.length) { valid = false; break }
        if (!data.slice(off + 8, off + 16).equals(ZERO_8)) { valid = false; break }
        const x = data.readDoubleBE ? data.readDoubleLE(off) : data.readDoubleLE(off)
        const z = data.readDoubleLE(off + 16)
        if (!isFinite(x) || !isFinite(z) || (x === 0 && z === 0)) { valid = false; break }
        const result = tmInv(z, x)
        if (!result) { valid = false; break }
        const [lat, lon] = result
        nodes.push([+lon.toFixed(7), +lat.toFixed(7)])
      }
      if (valid && nodes.length >= 2) {
        segments.push(nodes)
        i += 4 + n * 24
        continue
      }
    }
    i++
  }
  return segments
}

// ── Geometry: polyline → buffered polygon ─────────────────────────────────────

function bufferPolyline(coords, halfWidthM) {
  if (coords.length < 2) return null

  const originLon = coords[0][0]
  const originLat = coords[0][1]
  const cosLat      = Math.cos(originLat * Math.PI / 180)
  const mPerDegLat  = 111320
  const mPerDegLon  = mPerDegLat * cosLat

  // Convert to local metres
  const pts = coords.map(([lon, lat]) => [
    (lon - originLon) * mPerDegLon,
    (lat - originLat) * mPerDegLat,
  ])

  // Per-segment left normals (unit vectors)
  const normals = pts.slice(0, -1).map((pt, i) => {
    const dx = pts[i + 1][0] - pt[0]
    const dy = pts[i + 1][1] - pt[1]
    const len = Math.sqrt(dx * dx + dy * dy)
    if (len < 1e-10) return [0, 1]
    return [-dy / len, dx / len]
  })

  const left = []
  const right = []

  for (let i = 0; i < pts.length; i++) {
    let nx, ny
    if (i === 0) {
      nx = normals[0][0]; ny = normals[0][1]
    } else if (i === pts.length - 1) {
      nx = normals[normals.length - 1][0]; ny = normals[normals.length - 1][1]
    } else {
      // Miter join — average adjacent normals, scale to maintain width
      const ax = normals[i - 1][0] + normals[i][0]
      const ay = normals[i - 1][1] + normals[i][1]
      const mlen = Math.sqrt(ax * ax + ay * ay)
      if (mlen < 1e-10) {
        nx = normals[i][0]; ny = normals[i][1]
      } else {
        const scale = Math.min(1 / mlen, 3) // cap miter at 3× width
        nx = ax * scale; ny = ay * scale
      }
    }
    left.push( [pts[i][0] + nx * halfWidthM, pts[i][1] + ny * halfWidthM])
    right.push([pts[i][0] - nx * halfWidthM, pts[i][1] - ny * halfWidthM])
  }

  // Ring: left forward + right backward, closed
  const ring = [...left, ...[...right].reverse()]
  ring.push(ring[0])

  // Back to lon/lat
  return ring.map(([x, y]) => [
    +(originLon + x / mPerDegLon).toFixed(7),
    +(originLat + y / mPerDegLat).toFixed(7),
  ])
}

// ── Per-theatre build ─────────────────────────────────────────────────────────

function buildTheatre(theatre, dcsPath) {
  const tm      = TM_PARAMS[theatre]
  const nameMap = NAME_MAP[theatre] || {}
  const conf    = THEATRES[theatre]
  if (!tm || !conf) {
    console.log(`  ${theatre}: skipped — no TM params or theatre config`)
    return
  }

  const atDir = path.join(dcsPath, theatre, 'AirfieldsTaxiways')
  if (!fs.existsSync(atDir)) {
    console.log(`  ${theatre}: skipped — AirfieldsTaxiways not found`)
    return
  }

  // Theatre bbox for TM validation (with padding)
  const [minLon, minLat, maxLon, maxLat] = conf.bbox
  const PAD = 2
  const tmInv = makeTmInv(tm, minLat - PAD, maxLat + PAD, minLon - PAD, maxLon + PAD)

  // Load runway JSON
  const rwFile = RUNWAY_FILE[theatre] ?? theatre
  const rwPath = path.join(ROOT, 'client/public/runways', `${rwFile}.json`)
  if (!fs.existsSync(rwPath)) {
    console.log(`  ${theatre}: skipped — runway JSON not found (${rwFile}.json)`)
    return
  }
  const rwJson = JSON.parse(fs.readFileSync(rwPath, 'utf8'))

  // Index runway JSON by airbase name → runways[]
  const rwByAirbase = {}
  for (const ab of rwJson.airbases) {
    const rwys = (Array.isArray(ab.runways) ? ab.runways : []).filter(r => (r.width_ft || 0) > 0 && r.end1 && r.end2)
    if (rwys.length) rwByAirbase[ab.airbase] = rwys
  }

  const taxiFeatures = []
  const rwyFeatures  = []

  const rn5Files = fs.readdirSync(atDir).filter(f => f.endsWith('.rn5')).sort()

  for (const fname of rn5Files) {
    const stem    = path.basename(fname, '.rn5')
    const data    = fs.readFileSync(path.join(atDir, fname))
    const segs    = extractRn5(data, tmInv)

    // Taxiway polygons from rn5 segments
    for (const coords of segs) {
      const ring = bufferPolyline(coords, TAXIWAY_WIDTH_M / 2)
      if (!ring) continue
      taxiFeatures.push({
        type: 'Feature',
        properties: { airport: stem, type: 'taxiway', width_m: TAXIWAY_WIDTH_M },
        geometry: { type: 'Polygon', coordinates: [ring] },
      })
    }

    // Runway polygons — only if this stem maps to a runway JSON entry
    const airbaseName = nameMap[stem]
    const runways     = airbaseName ? rwByAirbase[airbaseName] : null
    if (runways) {
      for (const rwy of runways) {
        const widthM = rwy.width_ft * 0.3048
        const ring   = bufferPolyline(
          [[rwy.end1.lon, rwy.end1.lat], [rwy.end2.lon, rwy.end2.lat]],
          widthM / 2
        )
        if (!ring) continue
        rwyFeatures.push({
          type: 'Feature',
          properties: { airport: stem, type: 'runway', width_m: +widthM.toFixed(1) },
          geometry: { type: 'Polygon', coordinates: [ring] },
        })
      }
    }
  }

  // Taxiways first, runways last — sequential draw gives correct superimposition
  const features = [...taxiFeatures, ...rwyFeatures]
  const outDir   = path.join(CACHE_DIR, conf.folder)
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(
    path.join(outDir, 'airports_polygons.json'),
    JSON.stringify({ type: 'FeatureCollection', features })
  )

  const kb = (JSON.stringify({ type: 'FeatureCollection', features }).length / 1024).toFixed(0)
  console.log(
    `${theatre.padEnd(16)}  ${String(rn5Files.length).padStart(3)} airports  ` +
    `${String(taxiFeatures.length).padStart(5)} taxiways  ` +
    `${String(rwyFeatures.length).padStart(3)} runways  ` +
    `${kb.padStart(6)} KB`
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  let dcsPath = DEFAULT_DCS_PATH
  const args  = process.argv.slice(2)
  const dpIdx = args.indexOf('--dcs-path')
  if (dpIdx !== -1) {
    dcsPath = args[dpIdx + 1]
    args.splice(dpIdx, 2)
  }

  const only = args[0]
  if (only && !TM_PARAMS[only]) {
    console.error(`Unknown theatre "${only}". Options: ${Object.keys(TM_PARAMS).join(', ')}`)
    process.exit(1)
  }

  console.log('\nBuilding airport polygon data\n')
  console.log(`DCS path: ${dcsPath}\n`)

  const theatres = only ? [only] : Object.keys(TM_PARAMS)
  for (const t of theatres) buildTheatre(t, dcsPath)

  console.log('\nDone.\n')
}

main()
