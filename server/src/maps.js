'use strict'

const fs       = require('fs')
const path     = require('path')
const readline = require('readline')

const MAPS_DIR   = path.join(__dirname, '../../server/maps')
const INDEX_PATH = path.join(MAPS_DIR, 'theatre_index.json')

// Theatre name → { theatreStyle, groups }
const cache = {}

// ── ICAO type → group name ────────────────────────────────────────────────────
const TYPE_GROUP = {
  4:  'CTR',
  7:  'TMA',
  25: 'CTA',
  13: 'ATZ',
  33: 'FIZ',
  10: 'FIR',
  11: 'UIR',
  1:  'Restricted',
  3:  'Prohibited',
  2:  'Danger',
}
// All other type codes (0, 5, 6, 8, 9, 12, 14, 15, 16, 17, 18, unrecognised) → 'Other'

// ── FAA icaoClass → group name ────────────────────────────────────────────────
const ICAO_CLASS_GROUP = { 1: 'Class B', 2: 'Class C', 3: 'Class D' }

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatLimit(limit) {
  if (!limit) return '?'
  const { value, unit, referenceDatum } = limit
  if (unit === 6) {
    if (value >= 660) return 'UNL'
    return `FL${String(value).padStart(3, '0')}`
  }
  let ft = value
  if (unit === 0) ft = Math.round(value * 3.28084)
  if (ft === 0) return 'SFC'
  if (referenceDatum === 1 && ft >= 18000) return `FL${String(Math.round(ft / 100)).padStart(3, '0')}`
  if (referenceDatum === 0) return `${ft}ft AGL`
  return `${ft}ft`
}

function centroidOf(geometry) {
  const coords = geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates[0]
  const ring = coords[0]
  let lng = 0, lat = 0
  for (const [x, y] of ring) { lng += x; lat += y }
  return [lng / ring.length, lat / ring.length]
}

function bboxOf(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
  for (const poly of polygons) {
    for (const ring of poly) {
      for (const [lng, lat] of ring) {
        if (lng < minLng) minLng = lng
        if (lng > maxLng) maxLng = lng
        if (lat < minLat) minLat = lat
        if (lat > maxLat) maxLat = lat
      }
    }
  }
  return [minLng, minLat, maxLng, maxLat]
}

async function parseFile(filePath) {
  return new Promise((resolve, reject) => {
    const features = []
    const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity })
    rl.on('line', (line) => {
      line = line.trim()
      if (!line) return
      try {
        const feat  = JSON.parse(line)
        const props = feat.properties
        const geom  = feat.geometry
        if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) return
        features.push({
          id:        feat.id,
          name:      props.name       ?? '',
          type:      props.type       ?? 0,
          icaoClass: props.icaoClass  ?? 8,
          floor:     formatLimit(props.lowerLimit),
          ceiling:   formatLimit(props.upperLimit),
          centroid:  centroidOf(geom),
          bbox:      bboxOf(geom),
          geometry:  geom,
        })
      } catch { /* skip malformed lines */ }
    })
    rl.on('close', () => resolve(features))
    rl.on('error', reject)
  })
}

function groupFeatures(features, theatreStyle) {
  const buckets = {}

  const add = (name, feat) => {
    if (!buckets[name]) buckets[name] = []
    buckets[name].push(feat)
  }

  if (theatreStyle === 'ICAO') {
    for (const feat of features) {
      add(TYPE_GROUP[feat.type] ?? 'Other', feat)
    }
  } else {
    // FAA: group by icaoClass; type 10/11 become FIR/UIR if present
    for (const feat of features) {
      if      (feat.type === 10) add('FIR', feat)
      else if (feat.type === 11) add('UIR', feat)
      else add(ICAO_CLASS_GROUP[feat.icaoClass] ?? 'Other', feat)
    }
  }

  // Discard empty groups; return as array preserving insertion order
  return Object.entries(buckets)
    .filter(([, feats]) => feats.length > 0)
    .map(([name, features]) => ({ name, features }))
}

async function loadTheatre(theatreName) {
  if (cache[theatreName]) return cache[theatreName]

  let index
  try { index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')) }
  catch { console.warn('[maps] theatre_index.json missing or unreadable'); return { theatreStyle: null, groups: [] } }

  const folder = index[theatreName]
  if (!folder) { console.warn(`[maps] no folder mapped for theatre: ${theatreName}`); return { theatreStyle: null, groups: [] } }

  const dir = path.join(MAPS_DIR, folder)
  if (!fs.existsSync(dir)) { console.warn(`[maps] folder not found: ${dir}`); return { theatreStyle: null, groups: [] } }

  // Scan all .ndgeojson files — no manifest
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ndgeojson'))
  if (files.length === 0) { console.warn(`[maps] no .ndgeojson files in ${dir}`); return { theatreStyle: null, groups: [] } }

  const allFeatures = []
  for (const file of files) {
    const feats = await parseFile(path.join(dir, file))
    allFeatures.push(...feats)
    console.log(`[maps] ${file}: ${feats.length} features`)
  }

  // Detect theatre style: any type > 0 → ICAO; all type === 0 → FAA
  const theatreStyle = allFeatures.some((f) => f.type > 0) ? 'ICAO' : 'FAA'
  console.log(`[maps] ${theatreName}: ${theatreStyle} theatre, ${allFeatures.length} total features`)

  const groups = groupFeatures(allFeatures, theatreStyle)
  console.log(`[maps] groups: ${groups.map((g) => `${g.name}(${g.features.length})`).join(', ')}`)

  const result = { theatreStyle, groups }
  cache[theatreName] = result
  return result
}

module.exports = { loadTheatre }
