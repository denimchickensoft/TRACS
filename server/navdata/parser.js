'use strict'

const fs       = require('fs')
const fsp      = require('fs/promises')
const path     = require('path')
const readline = require('readline')
const crypto   = require('crypto')

const CONFIG_DIR = path.join(__dirname, 'config')
const CACHE_DIR  = path.join(__dirname, 'cache')

const SOURCE_DIR = process.env.NAVDATA_SOURCE
  ?? path.join(__dirname, 'source')

// ── Stream helpers ────────────────────────────────────────────────────────────

function readLines(filePath, onLine) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    rl.on('line', onLine)
    rl.on('close', resolve)
    rl.on('error', reject)
  })
}

// Skip X-Plane dat file header lines (format marker, version line, blank)
function isXpHeader(t) {
  return !t || t === 'I' || t === '99' || /^\d{4} /.test(t)
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

function bboxIntersects(a, b) {
  // Both bbox are [minLon, minLat, maxLon, maxLat]
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3])
}

function inBbox([minLon, minLat, maxLon, maxLat], lon, lat) {
  return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat
}

function polygonBbox(coords) {
  let [minLon, minLat, maxLon, maxLat] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [lon, lat] of coords) {
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }
  return [minLon, minLat, maxLon, maxLat]
}

function polygonCentroid(coords) {
  const n = coords.length
  let sumLon = 0, sumLat = 0
  for (const [lon, lat] of coords) { sumLon += lon; sumLat += lat }
  return [+(sumLon / n).toFixed(6), +(sumLat / n).toFixed(6)]
}

// ── DMS → decimal (for airspace.txt DP lines) ────────────────────────────────

function dmsToDecimal(dms) {
  const [d, m = 0, s = 0] = dms.split(':').map(Number)
  return Math.abs(d) + m / 60 + s / 3600
}

function parseDpLine(val) {
  // Format: "DD:MM:SS N DDD:MM:SS W"
  const p = val.trim().split(/\s+/)
  if (p.length < 4) return null
  const lat = dmsToDecimal(p[0]) * (p[1].toUpperCase() === 'S' ? -1 : 1)
  const lon = dmsToDecimal(p[2]) * (p[3].toUpperCase() === 'W' ? -1 : 1)
  return (isNaN(lat) || isNaN(lon)) ? null : [lon, lat]
}

// ── Airspace (airspace.txt — OpenAir format) ──────────────────────────────────

async function parseAirspace(theatreConfigs) {
  const filePath = path.join(SOURCE_DIR, 'airspaces', 'airspace.txt')
  if (!fs.existsSync(filePath)) {
    console.log('[navdata] airspace.txt not found')
    return {}
  }

  const palettes     = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'airspace_colors.json'), 'utf8'))
  const labelColors  = palettes[0]?.colors ?? {}

  // acc[theatreName][acCode] = feature[]
  const acc = {}
  for (const name of Object.keys(theatreConfigs)) acc[name] = {}

  let cur = null

  const flush = () => {
    if (!cur || cur.coords.length < 3) { cur = null; return }
    const bbox     = polygonBbox(cur.coords)
    const centroid = polygonCentroid(cur.coords)
    const feature  = {
      name:     cur.name,
      floor:    cur.floor,
      ceiling:  cur.ceiling,
      centroid,
      bbox,
      geometry: { type: 'Polygon', coordinates: [[...cur.coords, cur.coords[0]]] },
    }
    for (const [tName, tConf] of Object.entries(theatreConfigs)) {
      if (bboxIntersects(bbox, tConf.bbox)) {
        if (!acc[tName][cur.ac]) acc[tName][cur.ac] = []
        acc[tName][cur.ac].push(feature)
      }
    }
    cur = null
  }

  await readLines(filePath, (line) => {
    const tag = line.slice(0, 2).trim()
    const val = line.slice(2).trim()
    if (tag === 'AC') { flush(); cur = { ac: val, name: '', floor: 'GND', ceiling: '', coords: [] } }
    else if (!cur)      return
    else if (tag === 'AN') cur.name    = val
    else if (tag === 'AL') cur.floor   = val
    else if (tag === 'AH') cur.ceiling = val
    else if (tag === 'DP') { const pt = parseDpLine(val); if (pt) cur.coords.push(pt) }
  })
  flush()

  const result = {}
  for (const [tName, byAc] of Object.entries(acc)) {
    result[tName] = {
      groups: Object.entries(byAc).map(([acCode, features]) => ({
        name: labelColors[acCode]?.label ?? acCode,
        acCode,
        features,
      })),
      palettes,
    }
  }
  return result
}

// ── Fix table (earth_fix.dat) ─────────────────────────────────────────────────

async function parseFixTable() {
  const filePath = path.join(SOURCE_DIR, 'earth_fix.dat')
  const all = []
  if (!fs.existsSync(filePath)) return all

  await readLines(filePath, (line) => {
    const t = line.trim()
    if (isXpHeader(t)) return
    const p = t.split(/\s+/)
    if (p.length < 5) return
    const lat = parseFloat(p[0])
    const lon = parseFloat(p[1])
    if (isNaN(lat) || isNaN(lon)) return
    all.push({ id: p[2], region: p[4], lat, lon })
  })
  return all
}

// ── Navaid table (earth_nav.dat) ──────────────────────────────────────────────

const NAV_DISPLAY_TYPES = new Set([2, 3, 12, 13])

async function parseNavaidTable() {
  const filePath = path.join(SOURCE_DIR, 'earth_nav.dat')
  const all = []
  if (!fs.existsSync(filePath)) return all

  await readLines(filePath, (line) => {
    const t = line.trim()
    if (isXpHeader(t)) return
    const p = t.split(/\s+/)
    if (p.length < 10) return
    const type = parseInt(p[0], 10)
    const lat  = parseFloat(p[1])
    const lon  = parseFloat(p[2])
    const freq = parseInt(p[4], 10) / 100
    if (isNaN(lat) || isNaN(lon) || isNaN(type)) return
    all.push({
      id:         p[7],
      type,
      lat,
      lon,
      freq,
      name:       p.slice(10).join(' '),
      forDisplay: NAV_DISPLAY_TYPES.has(type),
    })
  })
  return all
}

// ── Airport metadata (earth_aptmeta.dat) ──────────────────────────────────────

async function parseAptmeta() {
  const filePath = path.join(SOURCE_DIR, 'earth_aptmeta.dat')
  const all = []
  if (!fs.existsSync(filePath)) return all

  await readLines(filePath, (line) => {
    const t = line.trim()
    if (isXpHeader(t)) return
    const p = t.split(/\s+/)
    if (p.length < 4) return
    const lat = parseFloat(p[2])
    const lon = parseFloat(p[3])
    if (isNaN(lat) || isNaN(lon)) return
    all.push({ icao: p[0], lat, lon })
  })
  return all
}

// ── ATC sectors (atc.dat) ─────────────────────────────────────────────────────

async function parseAtcSectors() {
  const filePath = path.join(SOURCE_DIR, '1200 atc data', 'Earth nav data', 'atc.dat')
  if (!fs.existsSync(filePath)) {
    console.log('[navdata] atc.dat not found')
    return {}
  }

  const sectors = {}
  let ctrl = null
  let inPoly = false, polyFloor = 0, polyCeiling = 0, polyPoints = []

  const ensureKey = (key) => {
    if (!sectors[key]) {
      sectors[key] = {
        name:          ctrl.name,
        freqs:         [...ctrl.freqs],
        class:         ctrl.class,
        transitionAlt: ctrl.transitionAlt,
        sectors:       [],
      }
    }
  }

  const flushPoly = () => {
    if (!inPoly) return
    if (ctrl?.facilityId && ctrl?.role && polyPoints.length >= 3) {
      const key = `${ctrl.facilityId}:${ctrl.role}`
      ensureKey(key)
      sectors[key].sectors.push({ floor: polyFloor, ceiling: polyCeiling, polygon: [...polyPoints] })
    }
    inPoly = false
    polyPoints = []
  }

  const flushCtrl = () => {
    flushPoly()
    if (!ctrl?.facilityId || !ctrl?.role) { ctrl = null; return }
    const key = `${ctrl.facilityId}:${ctrl.role}`
    if (!sectors[key]) {
      ensureKey(key)
    } else {
      for (const f of ctrl.freqs) {
        if (!sectors[key].freqs.includes(f)) sectors[key].freqs.push(f)
      }
    }
    ctrl = null
  }

  await readLines(filePath, (line) => {
    const t = line.trim()
    if (!t) return

    if (t === 'CONTROLLER') { flushCtrl(); ctrl = { name: '', facilityId: '', role: '', freqs: [], class: null, transitionAlt: null }; return }
    if (t === 'CONTROLLER_END') { flushCtrl(); return }
    if (!ctrl) return

    if (t.startsWith('AIRSPACE_POLYGON_BEGIN')) {
      flushPoly()
      const p    = t.split(/\s+/)
      polyFloor   = parseInt(p[1], 10)
      polyCeiling = parseInt(p[2], 10)
      inPoly     = true
      polyPoints = []
      if (ctrl.facilityId && ctrl.role) ensureKey(`${ctrl.facilityId}:${ctrl.role}`)
      return
    }
    if (t === 'AIRSPACE_POLYGON_END') { flushPoly(); return }
    if (inPoly && t.startsWith('POINT')) {
      const p = t.split(/\s+/)
      const lat = parseFloat(p[1])
      const lon = parseFloat(p[2])
      if (!isNaN(lat) && !isNaN(lon)) polyPoints.push([lon, lat])
      return
    }

    if (t.startsWith('NAME '))             ctrl.name          = t.slice(5).trim()
    else if (t.startsWith('FACILITY_ID ')) ctrl.facilityId    = t.slice(12).trim()
    else if (t.startsWith('ROLE '))        ctrl.role          = t.slice(5).trim()
    else if (t.startsWith('CLASS '))       ctrl.class         = t.slice(6).trim()
    else if (t.startsWith('TRANSITION_ALT ')) ctrl.transitionAlt = parseInt(t.slice(15), 10)
    else if (t.startsWith('FREQ '))        ctrl.freqs.push(parseFloat((parseInt(t.slice(5), 10) / 100).toFixed(2)))
  })
  flushCtrl()

  return sectors
}

// ── Main build ────────────────────────────────────────────────────────────────

async function buildCache() {
  if (!fs.existsSync(SOURCE_DIR)) {
    console.log(`[navdata] source directory not found: ${SOURCE_DIR}`)
    return
  }

  const cycleFile = path.join(SOURCE_DIR, 'cycle.json')
  if (!fs.existsSync(cycleFile)) {
    console.log('[navdata] cycle.json not found — skipping')
    return
  }

  const cycleData   = JSON.parse(fs.readFileSync(cycleFile, 'utf8'))
  const theatresRaw = fs.readFileSync(path.join(CONFIG_DIR, 'theatres.json'), 'utf8')
  const theatres    = JSON.parse(theatresRaw)
  const bboxHash    = crypto.createHash('sha256').update(theatresRaw).digest('hex').slice(0, 16)

  // Files that must exist in every theatre folder for the cache to be considered valid.
  // Add entries here whenever a new output file is introduced to the builder.
  const REQUIRED_THEATRE_FILES = ['fixes.json', 'navaids.json', 'airports.json', 'airspace.json', 'ctrs.json']

  const manifestPath = path.join(CACHE_DIR, 'manifest.json')
  if (fs.existsSync(manifestPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      if (m.cycle === cycleData.cycle && m.revision === cycleData.revision && m.bboxHash === bboxHash) {
        const allPresent = Object.values(theatres).every((tConf) =>
          REQUIRED_THEATRE_FILES.every((f) => fs.existsSync(path.join(CACHE_DIR, tConf.folder, f)))
        )
        if (allPresent) {
          console.log(`[navdata] cache hit — cycle ${cycleData.cycle} rev ${cycleData.revision}`)
          return
        }
        console.log(`[navdata] cache incomplete — rebuilding`)
      }
    } catch { /* rebuild if manifest is corrupt */ }
  }

  console.log(`[navdata] building cache — cycle ${cycleData.cycle} rev ${cycleData.revision}`)
  const t0 = Date.now()

  await fsp.mkdir(CACHE_DIR, { recursive: true })

  // Parse global sources in parallel
  const [fixes, navaids, aptmeta, airspaceByTheatre, sectors] = await Promise.all([
    parseFixTable(),
    parseNavaidTable(),
    parseAptmeta(),
    parseAirspace(theatres),
    parseAtcSectors(),
  ])

  console.log(`[navdata] parsed — ${fixes.length} fixes, ${navaids.length} navaids, ${aptmeta.length} airports, ${Object.keys(sectors).length} ATC sectors`)

  // Write per-theatre cache files
  await Promise.all(Object.entries(theatres).map(async ([tName, tConf]) => {
    const folder = path.join(CACHE_DIR, tConf.folder)
    await fsp.mkdir(path.join(folder, 'procedures'), { recursive: true })

    const bbox = tConf.bbox

    const theatreFixes = fixes
      .filter(({ lon, lat }) => inBbox(bbox, lon, lat))
      .map(({ id, lat, lon }) => ({ id, lat: +lat.toFixed(6), lon: +lon.toFixed(6) }))

    const theatreNavaids = navaids
      .filter(({ lon, lat, forDisplay }) => forDisplay && inBbox(bbox, lon, lat))
      .map(({ id, type, lat, lon, freq, name }) => ({ id, type, lat: +lat.toFixed(6), lon: +lon.toFixed(6), freq, name }))

    // Airport ICAO list within bbox (for CIFP procedure parsing, Phase 5)
    const theatreAirports = aptmeta
      .filter(({ lon, lat }) => inBbox(bbox, lon, lat))
      .map(({ icao }) => icao)

    const airspace = airspaceByTheatre[tName] ?? { groups: [], colors: {} }
    const featureCount = airspace.groups.reduce((s, g) => s + g.features.length, 0)

    const theatreCtrs = Object.entries(sectors)
      .filter(([key]) => key.endsWith(':ctr'))
      .filter(([, entry]) => entry.sectors.some((sec) => {
        if (sec.polygon.length < 3) return false
        const [cLon, cLat] = polygonCentroid(sec.polygon)
        return inBbox(bbox, cLon, cLat)
      }))
      .map(([key, entry]) => ({ facilityId: key.split(':')[0], name: entry.name, freqs: entry.freqs }))
      .sort((a, b) => a.facilityId.localeCompare(b.facilityId))

    await Promise.all([
      fsp.writeFile(path.join(folder, 'fixes.json'),    JSON.stringify(theatreFixes)),
      fsp.writeFile(path.join(folder, 'navaids.json'),  JSON.stringify(theatreNavaids)),
      fsp.writeFile(path.join(folder, 'airports.json'), JSON.stringify(theatreAirports)),
      fsp.writeFile(path.join(folder, 'airspace.json'), JSON.stringify(airspace)),
      fsp.writeFile(path.join(folder, 'ctrs.json'),     JSON.stringify(theatreCtrs)),
    ])

    console.log(`[navdata] ${tName}: ${theatreFixes.length} fixes, ${theatreNavaids.length} navaids, ${featureCount} airspace features, ${theatreAirports.length} airports, ${theatreCtrs.length} CTRs`)
  }))

  await fsp.writeFile(path.join(CACHE_DIR, 'sectors.json'), JSON.stringify(sectors))

  const manifest = {
    cycle:    cycleData.cycle,
    revision: cycleData.revision,
    bboxHash,
    builtAt:  new Date().toISOString(),
  }
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2))

  console.log(`[navdata] cache built in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

module.exports = { buildCache, SOURCE_DIR, CACHE_DIR, CONFIG_DIR }
