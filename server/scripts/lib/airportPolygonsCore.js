'use strict'

// Shared core for airport surface polygon generation (ASDE-X module).
// Pure computation only — no filesystem config loading and no output writing,
// so this same code can run from a dev checkout or from the standalone
// terrainDataExe .exe, both of which load theatres.json/runway JSON from
// disk (dev: server/navdata/config + client/public/runways; exe: its
// adjacent manifest/ folder) and pass the parsed data in as arguments.
//
// For each theatre: reads DCS rn5 binary files (taxiway centerlines) and DCS
// runway JSON (authoritative runway endpoints), applies a two-layer
// superimposition approach, and returns GeoJSON features.

const fs   = require('fs')
const path = require('path')

const TAXIWAY_WIDTH_M = 22.0
const ZERO_8 = Buffer.alloc(8)

// Max distance between an unmatched stem's taxiway centroid and an unclaimed
// airbase's runway midpoint for the two to be suggested as the same airport.
const MATCH_RADIUS_M = 5000
const EARTH_R_M = 6371000

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
        const x = data.readDoubleLE(off)
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

// ── Location-based match suggestions ────────────────────────────────────────

function haversineM(a, b) {
  const toRad = d => d * Math.PI / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

function centroidOf(segs) {
  let sumLon = 0, sumLat = 0, n = 0
  for (const coords of segs) {
    for (const [lon, lat] of coords) { sumLon += lon; sumLat += lat; n++ }
  }
  return n ? { lon: sumLon / n, lat: sumLat / n } : null
}

// ── Per-theatre build ─────────────────────────────────────────────────────────
//
// Pure: takes already-loaded config for one theatre plus the DCS terrains dir,
// returns a result descriptor. Caller is responsible for writing output and
// logging.

function buildTheatre({ theatre, terrainsDir, tm, nameMap, conf, rwJson }) {
  if (!tm || !conf) {
    return { status: 'skip', reason: 'no TM params or theatre config' }
  }

  const atDir = path.join(terrainsDir, conf.terrainsFolder || theatre, 'AirfieldsTaxiways')
  if (!fs.existsSync(atDir)) {
    return { status: 'skip', reason: 'AirfieldsTaxiways not found' }
  }

  if (!rwJson) {
    return { status: 'skip', reason: 'runway JSON not found' }
  }

  // Theatre bbox for TM validation (with padding)
  const [minLon, minLat, maxLon, maxLat] = conf.bbox
  const PAD = 2
  const tmInv = makeTmInv(tm, minLat - PAD, maxLat + PAD, minLon - PAD, maxLon + PAD)

  // Index runway JSON by airbase name → runways[]
  const rwByAirbase = {}
  for (const ab of rwJson.airbases) {
    const rwys = (Array.isArray(ab.runways) ? ab.runways : []).filter(r => (r.width_ft || 0) > 0 && r.end1 && r.end2)
    if (rwys.length) rwByAirbase[ab.airbase] = rwys
  }

  const taxiFeatures = []
  const rwyFeatures  = []
  const unmatchedStems = []
  const unmatchedCentroids = {}
  const matchedAirbases = new Set()

  const rn5Files = fs.readdirSync(atDir).filter(f => f.endsWith('.rn5')).sort()

  for (const fname of rn5Files) {
    const stem = path.basename(fname, '.rn5')
    const data = fs.readFileSync(path.join(atDir, fname))
    const segs = extractRn5(data, tmInv)

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
      matchedAirbases.add(airbaseName)
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
    } else {
      unmatchedStems.push(stem)
      const centroid = centroidOf(segs)
      if (centroid) unmatchedCentroids[stem] = centroid
    }
  }

  const unclaimedAirbases = Object.keys(rwByAirbase).filter(name => !matchedAirbases.has(name)).sort()

  // Representative point per unclaimed airbase — average midpoint of its runways
  const airbaseCenters = {}
  for (const name of unclaimedAirbases) {
    const runways = rwByAirbase[name]
    let sumLon = 0, sumLat = 0
    for (const rwy of runways) {
      sumLon += (rwy.end1.lon + rwy.end2.lon) / 2
      sumLat += (rwy.end1.lat + rwy.end2.lat) / 2
    }
    airbaseCenters[name] = { lon: sumLon / runways.length, lat: sumLat / runways.length }
  }

  // Suggest pairings for unmatched stems whose taxiway centroid sits near an
  // unclaimed airbase's runway midpoint — same physical airport, still needs
  // a manual airport_name_map.json entry to confirm and apply.
  const suggestedPairs = []
  for (const [stem, centroid] of Object.entries(unmatchedCentroids)) {
    let best = null
    for (const [name, center] of Object.entries(airbaseCenters)) {
      const distanceM = Math.round(haversineM(centroid, center))
      if (!best || distanceM < best.distanceM) best = { airbase: name, distanceM }
    }
    if (best && best.distanceM <= MATCH_RADIUS_M) suggestedPairs.push({ stem, ...best })
  }
  suggestedPairs.sort((a, b) => a.distanceM - b.distanceM)

  // Taxiways first, runways last — sequential draw gives correct superimposition
  return {
    status: 'ok',
    features: [...taxiFeatures, ...rwyFeatures],
    airportCount: rn5Files.length,
    taxiCount: taxiFeatures.length,
    rwyCount: rwyFeatures.length,
    unmatchedStems,
    unclaimedAirbases,
    suggestedPairs,
  }
}

module.exports = { TAXIWAY_WIDTH_M, makeTmInv, extractRn5, bufferPolyline, buildTheatre }
