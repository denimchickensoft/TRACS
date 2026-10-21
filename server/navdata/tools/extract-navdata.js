'use strict'

const path   = require('path')
const fs     = require('fs')
const fsp    = require('fs/promises')
const crypto = require('crypto')

// ── Paths ─────────────────────────────────────────────────────────────────────

const TOOL_DIR       = __dirname                          // server/navdata/tools
const NAVDATA_DIR    = path.resolve(TOOL_DIR, '..')      // server/navdata
const SERVER_DIR     = path.resolve(NAVDATA_DIR, '..')   // server
const PROJECT_DIR    = path.resolve(SERVER_DIR, '..')    // project root

const CONFIG_DIR         = path.join(NAVDATA_DIR, 'config')
// Same TRACS_NAVDATA_CACHE_DIR override as server/navdata/parser.js's
// CACHE_DIR — duplicated rather than imported to avoid a circular require
// (parser.js already requires this file for runExtract).
const CACHE_DIR          = process.env.TRACS_NAVDATA_CACHE_DIR
  ? path.resolve(process.env.TRACS_NAVDATA_CACHE_DIR)
  : path.join(NAVDATA_DIR, 'cache')
const ICAO_MAPPING_PATH  = path.join(PROJECT_DIR, 'client', 'public', 'icaoMapping.json')
const FIR_IDENTS_PATH    = path.join(CONFIG_DIR, 'fir_idents.json')
// DCS airbase runway data: client/public in a source checkout; an installed
// copy only has the built client's copy.
const RUNWAYS_DIRS       = [
  path.join(PROJECT_DIR, 'client', 'public', 'runways'),
  path.join(PROJECT_DIR, 'client', 'dist', 'runways'),
]

// An ident whose LNM airport is further than this from the DCS airbase it's
// mapped to is a different airport (e.g. a historical DCS code LNM now gives
// to another field), so none of LNM's data for it is used.
const MAX_AIRPORT_OFFSET_KM = 5
const KM_PER_NM = 1.852

// Bumped when the extract's output changes in a way an existing cache
// doesn't have, so parser.js re-extracts once (it compares the manifest's).
// 2: procedures/ is rebuilt from scratch each run.
const EXTRACT_VERSION = 2

// ── Geometry helpers ──────────────────────────────────────────────────────────

function polygonBbox(coords) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
  for (const [lon, lat] of coords) {
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }
  return [minLon, minLat, maxLon, maxLat]
}

function polygonArea(coords) {
  let area = 0
  const n = coords.length
  for (let i = 0; i < n; i++) {
    const [x1, y1] = coords[i]
    const [x2, y2] = coords[(i + 1) % n]
    area += x1 * y2 - x2 * y1
  }
  return Math.abs(area) / 2
}

function centroid(coords) {
  const n = coords.length
  let sumLon = 0, sumLat = 0
  for (const [lon, lat] of coords) { sumLon += lon; sumLat += lat }
  return [sumLon / n, sumLat / n]
}

function nmBetween(lat1, lon1, lat2, lon2) {
  const R  = 3440.065
  const φ1 = lat1 * Math.PI / 180
  const φ2 = lat2 * Math.PI / 180
  const Δφ = (lat2 - lat1) * Math.PI / 180
  const Δλ = (lon2 - lon1) * Math.PI / 180
  const a  = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function projectPoint(lat, lon, courseDeg, distNm) {
  const R  = 3440.065
  const d  = distNm / R
  const θ  = courseDeg * Math.PI / 180
  const φ1 = lat * Math.PI / 180
  const λ1 = lon * Math.PI / 180
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2))
  return [φ2 * 180 / Math.PI, λ2 * 180 / Math.PI]
}

// ── Blob decoder (boundary / msa geometry) ────────────────────────────────────

function decodeGeometry(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
  const n = buf.readUInt32BE(0)
  const coords = []
  for (let i = 0; i < n; i++) {
    const lon = buf.readFloatBE(4 + i * 8)
    const lat = buf.readFloatBE(8 + i * 8)
    coords.push([lon, lat])
  }
  return coords
}

// ── displayCategory mapping ───────────────────────────────────────────────────

// LNM boundary.type codes — meanings are fixed by LittleNavmap's
// airspaceTypeFromDatabaseMap (LittleNavMap source, src/common/maptypes.cpp).
// Do NOT guess these from intuition.
//   T=TOWER(CTR)  GCA=General Control Area(terminal→TMA)  CA=CLASS A  CN=CAUTION(→SUA)
//   C=CENTER(→CTA)  M=MOA  MCTR=Military Control Zone(→CTR)  RD=RADAR(→MIL)  DA=DANGER
const TYPE_TO_CATEGORY = {
  T: 'CTR', GCA: 'TMA', MCTR: 'CTR',
  C: 'CTA', CA: 'CLASS A', CN: 'SUA',
  CB: 'CLASS B', CC: 'CLASS C', CD: 'CLASS D',
  CE: 'CLASS E', CF: 'CLASS F', CG: 'CLASS G',
  FIR: 'FIR', UIR: 'UIR',
  R: 'SUA', P: 'SUA', DA: 'SUA', W: 'SUA', AL: 'SUA', TR: 'SUA',
  M: 'MIL', RD: 'MIL', TRSA: 'TRSA',
}

const CATEGORY_ORDER = [
  'CTR', 'TMA', 'CTA', 'CLASS A', 'CLASS B', 'CLASS C', 'CLASS D',
  'CLASS E', 'CLASS F', 'CLASS G', 'FIR', 'UIR', 'SUA', 'MIL', 'TRSA',
]

function toDisplayCategory(lnmType) {
  return TYPE_TO_CATEGORY[lnmType] ?? 'CTA'
}

// ── Altitude label formatting ─────────────────────────────────────────────────

const CATEGORY_PREFIX = {
  CTR: 'CTR', TMA: 'TMA', CTA: 'CTA',
  'CLASS A': 'A', 'CLASS B': 'B', 'CLASS C': 'C', 'CLASS D': 'D',
  'CLASS E': 'E', 'CLASS F': 'F', 'CLASS G': 'G',
  FIR: null, UIR: null,
  SUA: undefined,  // use normalized LNM type
  MIL: 'MIL', TRSA: 'TRSA',
}

// Normalize raw LNM type to a user-friendly SUA prefix
const SUA_PREFIX = { R: 'R', P: 'P', D: 'D', DA: 'D', W: 'W', AL: 'D', TR: 'R' }

function formatAlt(value, type) {
  if (value == null) return '?'
  if (value === 0)                          return 'GND'
  if (value >= 99000 || type === 'UNL')    return 'UNL'
  if (value >= 18000)                       return `FL${Math.round(value / 100)}`
  return `${value} ${type || 'MSL'}`
}

function makeAltLabel(category, lnmType, floor, ceiling, floorType, ceilingType) {
  const pv = CATEGORY_PREFIX[category]
  const prefix = pv === undefined ? (SUA_PREFIX[lnmType] ?? lnmType) : pv
  const range = `${formatAlt(floor, floorType)}–${formatAlt(ceiling, ceilingType)}`
  return prefix ? `${prefix} · ${range}` : range
}

// ── sql.js query helpers ──────────────────────────────────────────────────────

function queryAll(db, sql, params = []) {
  const stmt = db.prepare(sql)
  if (params.length) stmt.bind(params)
  const rows = []
  while (stmt.step()) rows.push(stmt.getAsObject())
  stmt.free()
  return rows
}

function queryOne(db, sql, params = []) {
  return queryAll(db, sql, params)[0] ?? null
}

// ── Extractor: fixes ──────────────────────────────────────────────────────────

function extractFixes(db, [minLon, minLat, maxLon, maxLat]) {
  const rows = queryAll(db,
    'SELECT ident, lonx, laty FROM waypoint WHERE lonx BETWEEN ? AND ? AND laty BETWEEN ? AND ?',
    [minLon, maxLon, minLat, maxLat],
  )
  return rows.map(r => ({ id: r.ident, lat: +r.laty.toFixed(6), lon: +r.lonx.toFixed(6) }))
}

// ── Extractor: navaids ────────────────────────────────────────────────────────

function extractNavaids(db, [minLon, minLat, maxLon, maxLat]) {
  const vors = queryAll(db,
    'SELECT ident, name, type, frequency, lonx, laty FROM vor WHERE lonx BETWEEN ? AND ? AND laty BETWEEN ? AND ?',
    [minLon, maxLon, minLat, maxLat],
  )
  const ndbs = queryAll(db,
    'SELECT ident, name, frequency, lonx, laty FROM ndb WHERE lonx BETWEEN ? AND ? AND laty BETWEEN ? AND ?',
    [minLon, maxLon, minLat, maxLat],
  )
  const result = []
  for (const r of vors) {
    result.push({ id: r.ident, type: r.type, lat: +r.laty.toFixed(6), lon: +r.lonx.toFixed(6), freq: +(r.frequency / 10).toFixed(2), name: r.name })
  }
  for (const r of ndbs) {
    result.push({ id: r.ident, type: 'NDB', lat: +r.laty.toFixed(6), lon: +r.lonx.toFixed(6), freq: r.frequency, name: r.name })
  }
  return result
}

// ── Extractor: airspace ───────────────────────────────────────────────────────

function extractAirspace(db, [minLon, minLat, maxLon, maxLat]) {
  // LNM stores antimeridian-crossing boundaries with min_lonx > max_lonx
  // (Oakland Oceanic: 130 .. -120); their lon range is [min,180] U [-180,max].
  const rows = queryAll(db,
    `SELECT boundary_id, type, name, min_altitude, max_altitude, min_altitude_type, max_altitude_type, geometry,
            min_lonx > max_lonx AS wraps
     FROM boundary
     WHERE ((min_lonx <= max_lonx AND min_lonx < ? AND max_lonx > ?)
         OR (min_lonx >  max_lonx AND (min_lonx < ? OR max_lonx > ?)))
       AND min_laty < ? AND max_laty > ?`,
    [maxLon, minLon, maxLon, minLon, maxLat, minLat],
  )
  const theatreLon = (minLon + maxLon) / 2

  const features = []
  for (const r of rows) {
    if (!r.geometry) continue
    let coords
    try { coords = decodeGeometry(r.geometry) } catch { continue }
    if (coords.length < 3) continue
    // The ring is split along +/-180; shift every vertex to within 180 deg of
    // the theatre so the projection sees one continuous polygon.
    if (r.wraps) coords = coords.map(([lon, lat]) => [lon + 360 * Math.round((theatreLon - lon) / 360), lat])

    const cat      = toDisplayCategory(r.type)
    const altLabel = makeAltLabel(cat, r.type, r.min_altitude, r.max_altitude, r.min_altitude_type, r.max_altitude_type)
    const nameLabel = (r.name ?? '').slice(0, 25)

    features.push({
      id:              r.boundary_id,
      name:            r.name ?? '',
      displayCategory: cat,
      isParent:        false,
      floor:           r.min_altitude   ?? 0,
      ceiling:         r.max_altitude   ?? 0,
      floorType:       r.min_altitude_type  ?? 'MSL',
      ceilingType:     r.max_altitude_type  ?? 'MSL',
      nameLabel,
      altLabel,
      bbox:            polygonBbox(coords),
      _area:           polygonArea(coords),
      geometry:        { type: 'Polygon', coordinates: [[...coords, coords[0]]] },
    })
  }

  // Mark largest polygon in each (name, displayCategory) group as isParent
  const groups = new Map()
  for (const f of features) {
    const key = `${f.name}|${f.displayCategory}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(f)
  }
  for (const group of groups.values()) {
    group.reduce((best, f) => f._area > best._area ? f : best, group[0]).isParent = true
  }
  for (const f of features) delete f._area

  // Collect categories in canonical order (only those present in data)
  const catSet     = new Set(features.map(f => f.displayCategory))
  const categories = CATEGORY_ORDER.filter(c => catSet.has(c))

  return { categories, features }
}

// ── Extractor: holdings ───────────────────────────────────────────────────────

function extractHoldings(db, [minLon, minLat, maxLon, maxLat]) {
  const rows = queryAll(db,
    `SELECT nav_ident, course, turn_direction, leg_time, leg_length, minimum_altitude, speed_limit, lonx, laty
     FROM holding WHERE lonx BETWEEN ? AND ? AND laty BETWEEN ? AND ?`,
    [minLon, maxLon, minLat, maxLat],
  )
  const seen = new Set()
  const out  = []
  for (const r of rows) {
    const key = `${r.nav_ident}|${r.lonx.toFixed(4)}|${r.laty.toFixed(4)}|${r.course}|${r.turn_direction}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      ident:      r.nav_ident,
      lat:        +r.laty.toFixed(6),
      lon:        +r.lonx.toFixed(6),
      course:     r.course,
      turnDir:    r.turn_direction,
      legTime:    r.leg_time   ?? null,
      legLength:  r.leg_length ?? null,
      minAlt:     r.minimum_altitude ?? null,
      speedLimit: r.speed_limit      ?? null,
    })
  }
  return out
}

// ── Extractor: airways ────────────────────────────────────────────────────────

function extractAirways(db, [minLon, minLat, maxLon, maxLat]) {
  // LNM column names: airway_name, airway_type (not name/type)
  const rows = queryAll(db,
    `SELECT a.airway_name, a.airway_type,
            a.from_lonx, a.from_laty, a.to_lonx, a.to_laty,
            a.minimum_altitude, a.maximum_altitude,
            wf.ident AS from_ident, wt.ident AS to_ident
     FROM airway a
     JOIN waypoint wf ON wf.waypoint_id = a.from_waypoint_id
     JOIN waypoint wt ON wt.waypoint_id = a.to_waypoint_id
     WHERE (a.from_lonx BETWEEN ? AND ? AND a.from_laty BETWEEN ? AND ?)
        OR (a.to_lonx   BETWEEN ? AND ? AND a.to_laty   BETWEEN ? AND ?)`,
    [minLon, maxLon, minLat, maxLat,
     minLon, maxLon, minLat, maxLat],
  )
  const out = { V: [], J: [], B: [] }
  for (const r of rows) {
    const seg = {
      name:   r.airway_name,
      from:   [+r.from_lonx.toFixed(6), +r.from_laty.toFixed(6)],
      to:     [+r.to_lonx.toFixed(6),   +r.to_laty.toFixed(6)],
      fromId: r.from_ident ?? null,
      toId:   r.to_ident   ?? null,
      minAlt: r.minimum_altitude ?? null,
      maxAlt: r.maximum_altitude ?? null,
    }
    if (r.airway_type === 'V')      out.V.push(seg)
    else if (r.airway_type === 'J') out.J.push(seg)
    else if (r.airway_type === 'B') out.B.push(seg)
  }
  return out
}

// ── MSA geometry blob decoder ─────────────────────────────────────────────────
// Format: uint16_BE point count N, then N × (float32_BE lon, float32_BE lat).
// Trailing bytes: uint8 sector count S, then S × (float32_BE bearing, float32_BE altFt,
//   float32_BE labelLon, float32_BE labelLat, float32_BE endLon, float32_BE endLat).

function decodeMsaBlob(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
  if (buf.length < 2) return { geometry: [], sectors: [] }
  const n      = buf.readUInt16BE(0)
  const ringEnd = 2 + n * 8
  if (ringEnd > buf.length) return { geometry: [], sectors: [] }

  const geometry = []
  for (let i = 0; i < n; i++) {
    const off = 2 + i * 8
    geometry.push([buf.readFloatBE(off), buf.readFloatBE(off + 4)])
  }

  const sectors = []
  if (buf.length > ringEnd) {
    const s = buf.readUInt8(ringEnd)
    for (let i = 0; i < s; i++) {
      const off = ringEnd + 1 + i * 24
      if (off + 8 > buf.length) break
      sectors.push({
        bearing: +buf.readFloatBE(off).toFixed(1),
        altFt:   Math.round(buf.readFloatBE(off + 4)),
      })
    }
  }

  return { geometry, sectors }
}

// ── Extractor: MSA ────────────────────────────────────────────────────────────

function extractMsa(db, [minLon, minLat, maxLon, maxLat]) {
  // Table is airport_msa (not msa). One row per sector; deduplicate by ring center.
  // Bbox columns: left_lonx, top_laty, right_lonx, bottom_laty.
  const rows = queryAll(db,
    `SELECT airport_ident, nav_ident, lonx, laty, radius, geometry
     FROM airport_msa
     WHERE left_lonx < ? AND right_lonx > ? AND bottom_laty < ? AND top_laty > ?
       AND length(nav_ident) = 4`,
    [maxLon, minLon, maxLat, minLat],
  )

  // Deduplicate by nav fix position — multiple airports can share the same ring,
  // and ARINC 424 multiple_code produces variant rows at the same position.
  const seen = new Set()
  const out  = []
  for (const r of rows) {
    const key = `${r.nav_ident}|${r.lonx.toFixed(4)}|${r.laty.toFixed(4)}`
    if (seen.has(key)) continue
    seen.add(key)

    let geometry = [], sectors = []
    if (r.geometry) try { ({ geometry, sectors } = decodeMsaBlob(r.geometry)) } catch {}

    out.push({
      ident:    r.nav_ident ?? '',
      lat:      +r.laty.toFixed(6),
      lon:      +r.lonx.toFixed(6),
      radiusNm: r.radius ?? null,
      geometry,
      sectors,
    })
  }
  return out
}

// ── Extractor: MORA grid ──────────────────────────────────────────────────────

function extractMora(db, [minLon, minLat, maxLon, maxLat]) {
  let row
  try {
    row = queryOne(db, 'SELECT geometry FROM mora_grid WHERE mora_grid_id = 1')
  } catch (err) {
    console.warn('[extract] mora_grid query failed:', err.message)
    return []
  }
  if (!row?.geometry) return []

  const buf    = Buffer.isBuffer(row.geometry) ? row.geometry : Buffer.from(row.geometry)
  const HEADER = 8
  const out    = []

  // Theatre row/col bounds
  const rowMin = 90 - Math.floor(maxLat)
  const rowMax = 90 - Math.floor(minLat)
  const colMin = Math.floor(minLon) + 180
  const colMax = Math.floor(maxLon) + 180

  for (let ri = Math.max(0, rowMin); ri <= Math.min(179, rowMax); ri++) {
    for (let ci = Math.max(0, colMin); ci <= Math.min(359, colMax); ci++) {
      const offset = HEADER + (ri * 360 + ci) * 2
      if (offset + 2 > buf.length) continue
      const val = buf.readUInt16BE(offset)
      if (val <= 10) continue           // ocean / no data
      out.push({ lat: 90 - ri, lon: ci - 180, val })
    }
  }
  return out
}

// ── Extractor: procedures ─────────────────────────────────────────────────────

const LEG_TYPES_NO_FIX = new Set(['CA', 'VA', 'CI', 'VI', 'VM', 'FA', 'FC', 'FD', 'FM'])

function buildRunwayMap(db, airportId) {
  const rows = queryAll(db,
    `SELECT re.name, re.lonx, re.laty
     FROM runway_end re
     JOIN runway r ON re.runway_end_id IN (r.primary_end_id, r.secondary_end_id)
     WHERE r.airport_id = ?`,
    [airportId],
  )
  const map = {}
  for (const r of rows) map[r.name] = { lon: r.lonx, lat: r.laty }
  return map
}

const APPROACH_LEG_FIELDS = `
  type, fix_ident, fix_lonx, fix_laty,
  course, distance,
  altitude1, altitude2, alt_descriptor,
  turn_direction,
  recommended_fix_ident, recommended_fix_lonx, recommended_fix_laty,
  speed_limit, speed_limit_type,
  is_missed`

const TRANSITION_LEG_FIELDS = `
  type, fix_ident, fix_lonx, fix_laty,
  course, distance,
  altitude1, altitude2, alt_descriptor,
  turn_direction,
  recommended_fix_ident, recommended_fix_lonx, recommended_fix_laty,
  speed_limit, speed_limit_type`

function buildPolyline(legs, runwayMap, runwayName) {
  const pts = []
  let prev  = null

  for (const leg of legs) {
    const pt = {}
    if (leg.is_missed)                          pt.missed   = true
    if (leg.alt_descriptor)                     pt.alt_desc = leg.alt_descriptor
    if (leg.altitude1)                          pt.alt1     = leg.altitude1
    if (leg.altitude2)                          pt.alt2     = leg.altitude2
    if (leg.speed_limit)                        pt.spd      = leg.speed_limit
    if (leg.speed_limit_type)                   pt.spd_type = leg.speed_limit_type
    if (leg.turn_direction)                     pt.turn     = leg.turn_direction
    if (leg.recommended_fix_ident)              pt.rec_id   = leg.recommended_fix_ident
    if (leg.recommended_fix_lonx != null)       pt.rec_lon  = +leg.recommended_fix_lonx.toFixed(6)
    if (leg.recommended_fix_laty != null)       pt.rec_lat  = +leg.recommended_fix_laty.toFixed(6)

    if (leg.fix_laty != null && leg.fix_lonx != null) {
      pt.lat = +leg.fix_laty.toFixed(6)
      pt.lon = +leg.fix_lonx.toFixed(6)
      if (leg.fix_ident) pt.id = leg.fix_ident
      pts.push(pt)
      prev = pt
    } else if (LEG_TYPES_NO_FIX.has(leg.type) && leg.course != null) {
      let origin = prev
      if (!origin && runwayName && runwayMap[runwayName]) {
        const rwy = runwayMap[runwayName]
        origin = { lat: rwy.lat, lon: rwy.lon }
      }
      if (origin) {
        const dist = (leg.distance > 0) ? leg.distance : 5
        const [lat, lon] = projectPoint(origin.lat, origin.lon, leg.course, dist)
        pt.lat = +lat.toFixed(6)
        pt.lon = +lon.toFixed(6)
        pts.push(pt)
        prev = pt
      }
    }
  }
  return pts
}

function extractTransitions(db, approachId, runwayMap, rwyName) {
  const transitions = queryAll(db,
    'SELECT transition_id, fix_ident FROM transition WHERE approach_id = ?',
    [approachId],
  )
  const result = {}
  for (const t of transitions) {
    const legs = queryAll(db,
      `SELECT ${TRANSITION_LEG_FIELDS} FROM transition_leg WHERE transition_id = ? ORDER BY transition_leg_id`,
      [t.transition_id],
    )
    const poly = buildPolyline(legs, runwayMap, rwyName)
    if (poly.length > 0) result[t.fix_ident] = poly
  }
  return result
}

function extractProceduresForAirport(db, airportId) {
  const runwayMap = buildRunwayMap(db, airportId)
  const procs     = queryAll(db,
    'SELECT approach_id, type, suffix, arinc_name, runway_name, fix_ident FROM approach WHERE airport_id = ? ORDER BY suffix, fix_ident',
    [airportId],
  )

  const out = { SID: {}, STAR: {}, APPCH: {} }

  for (const proc of procs) {
    const suffix  = proc.suffix
    const rwyName = proc.runway_name ?? ''
    const apType  = proc.type ?? ''

    let category, procName, transKey

    if (suffix === 'D') {
      category = 'SID'
      procName = proc.fix_ident ?? ''
      transKey = rwyName
    } else if (suffix === 'A') {
      category = 'STAR'
      procName = proc.fix_ident ?? ''
      transKey = rwyName
    } else {
      category = 'APPCH'
      procName = proc.arinc_name ?? proc.fix_ident ?? ''
      transKey = ''
    }

    if (!out[category][procName]) {
      const meta = { type: apType, transitions: {} }
      if (category === 'APPCH' && rwyName) meta.runway = rwyName
      out[category][procName] = meta
    }
    const entry = out[category][procName]

    // Main legs
    const mainLegs = queryAll(db,
      `SELECT ${APPROACH_LEG_FIELDS} FROM approach_leg WHERE approach_id = ? ORDER BY approach_leg_id`,
      [proc.approach_id],
    )
    const mainPoly = buildPolyline(mainLegs, runwayMap, rwyName)
    if (mainPoly.length > 0) entry.transitions[transKey] = mainPoly

    // Transitions — IAF entries for APPCH, enroute transitions for SID/STAR
    const transPolys = extractTransitions(db, proc.approach_id, runwayMap, rwyName)
    Object.assign(entry.transitions, transPolys)
  }

  return out
}

// ── Extractor: centers (FIR/UIR boundaries + idents) ──────────────────────────

// LNM boundaries carry no FIR ident, so idents come from config/fir_idents.json
// ("FIR|TBILISI" -> "UGGG"). Several boundaries can share one ident when
// smaller FIRs fall under a parent ACC (MURMANSK, ARKHANGELSK -> ULLL).
function extractCenterBoundaries(db, firIdents) {
  const rows = queryAll(db,
    `SELECT type, name, com_frequency, min_lonx, min_laty, max_lonx, max_laty
     FROM boundary WHERE type IN ('FIR', 'UIR')`,
  )
  const out = []
  for (const r of rows) {
    const ident = firIdents[`${r.type}|${r.name}`]
    if (!ident) continue
    // LNM's bbox columns mark antimeridian-crossing boundaries with
    // min_lonx > max_lonx (Oakland Oceanic: 130 .. -120); unwrap to a
    // continuous range (130 .. 240) so overlap and centering stay simple.
    const maxLon = r.min_lonx > r.max_lonx ? r.max_lonx + 360 : r.max_lonx
    const bbox   = [r.min_lonx, r.min_laty, maxLon, r.max_laty]
    out.push({
      ident,
      type: r.type,
      name: r.name,
      freq: r.com_frequency ? +(r.com_frequency / 1_000).toFixed(3) : null,
      bbox,
    })
  }
  return out
}

// One entry per ident whose boundaries overlap the theatre. The name and the
// frequency order favour FIR over UIR rows, then the part of the FIR that is
// actually inside the theatre; the center is the middle of the FIR's bbox
// clipped to the theatre bbox, so a large ACC (ULLL over Kola) centers on the
// theatre rather than on the far end of the FIR.
function buildTheatreCenters(boundaries, theatreBbox) {
  // Unwrapped FIR bboxes can run past 180, so also try the theatre one turn east.
  const [tMinLon, tMinLat, tMaxLon, tMaxLat] = theatreBbox
  const frames = [[tMinLon, tMaxLon], [tMinLon + 360, tMaxLon + 360]]
  const byIdent = new Map()
  for (const b of boundaries) {
    const [minLon, minLat, maxLon, maxLat] = b.bbox
    let clip = null
    for (const [fMin, fMax] of frames) {
      const c = [Math.max(minLon, fMin), Math.max(minLat, tMinLat), Math.min(maxLon, fMax), Math.min(maxLat, tMaxLat)]
      if (c[0] < c[2] && c[1] < c[3]) { clip = c; break }
    }
    if (!clip) continue
    const overlap = (clip[2] - clip[0]) * (clip[3] - clip[1])
    if (!byIdent.has(b.ident)) byIdent.set(b.ident, [])
    byIdent.get(b.ident).push({ ...b, clip, overlap })
  }

  const centers = []
  for (const [ident, parts] of byIdent) {
    parts.sort((a, b) => (a.type === 'FIR' ? 0 : 1) - (b.type === 'FIR' ? 0 : 1) || b.overlap - a.overlap)
    const freqs = [...new Set(parts.map(p => p.freq).filter(f => f != null))]
    if (freqs.length === 0) continue
    const firParts = parts.filter(p => p.type === 'FIR')
    const area     = firParts.length ? firParts : parts
    const clip = [
      Math.min(...area.map(p => p.clip[0])), Math.min(...area.map(p => p.clip[1])),
      Math.max(...area.map(p => p.clip[2])), Math.max(...area.map(p => p.clip[3])),
    ]
    centers.push({
      facilityId: ident,
      name:       parts[0].name,
      freqs,
      lat:        +((clip[1] + clip[3]) / 2).toFixed(6),
      lon:        +((((clip[0] + clip[2]) / 2 + 540) % 360) - 180).toFixed(6),
    })
  }
  return centers.sort((a, b) => a.facilityId.localeCompare(b.facilityId))
}

// ── Extractor: sectors (com + boundary matching) ──────────────────────────────

function extractSectors(db, allIcaos) {
  // Load all TMA/GCA boundaries globally for polygon matching
  const rawBounds = queryAll(db,
    `SELECT name, geometry FROM boundary WHERE type IN ('T', 'GCA')`,
  )
  const bounds = rawBounds.map(b => {
    let coords = []
    if (b.geometry) try { coords = decodeGeometry(b.geometry) } catch {}
    return {
      name:     (b.name ?? '').toUpperCase(),
      coords,
      centroid: coords.length >= 3 ? centroid(coords) : null,
    }
  })

  const COM_ROLES = { T: 'twr', A: 'app', D: 'dep', G: 'gnd', C: 'ctr', INF: 'ctr', ATIS: 'atis', RMP: 'gnd' }
  const sectors   = {}

  for (const icao of allIcaos) {
    const airport = queryOne(db,
      'SELECT airport_id, name, lonx, laty FROM airport WHERE ident = ?',
      [icao],
    )
    if (!airport) continue

    const comRows = queryAll(db,
      'SELECT type, frequency FROM com WHERE airport_id = ?',
      [airport.airport_id],
    )
    if (comRows.length === 0) continue

    const freqs = {}
    for (const r of comRows) {
      const role = COM_ROLES[r.type]
      if (!role) continue
      const mhz = +(r.frequency / 1_000).toFixed(3)
      if (!freqs[role]) freqs[role] = []
      if (!freqs[role].includes(mhz)) freqs[role].push(mhz)
    }
    if (Object.keys(freqs).length === 0) continue

    // Find matching TMA/GCA boundary polygon
    const icaoUpper = icao.toUpperCase()
    let match = bounds.find(b => b.name.includes(icaoUpper))
    if (!match) {
      let bestDist = Infinity
      for (const b of bounds) {
        if (!b.centroid) continue
        const dist = nmBetween(airport.laty, airport.lonx, b.centroid[1], b.centroid[0])
        if (dist < 50 && dist < bestDist) { bestDist = dist; match = b }
      }
    }

    sectors[icaoUpper] = {
      name:    airport.name ?? icaoUpper,
      icao:    icaoUpper,
      lat:     +airport.laty.toFixed(6),
      lon:     +airport.lonx.toFixed(6),
      freqs,
      ...(match?.coords?.length >= 3 ? { polygon: match.coords } : {}),
    }
  }

  return sectors
}

// Cheap sanity check that a user-supplied path is really an LNM navigraph DB
// (not some other little_navmap_*.sqlite, and not an unrelated/corrupt file) —
// used by the settings endpoint to fail fast with a clear message before
// committing to a full runExtract().
async function validateLnmDb(lnmDbPath) {
  if (!fs.existsSync(lnmDbPath)) {
    throw new Error(`file not found: ${lnmDbPath}`)
  }
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs()
  let db
  try {
    db = new SQL.Database(fs.readFileSync(lnmDbPath))
    const row = queryOne(db, 'SELECT 1 FROM airport LIMIT 1')
    if (!row) throw new Error('no rows in airport table')
  } catch (err) {
    throw new Error(`not a valid LNM navigraph database: ${err.message}`, { cause: err })
  } finally {
    db?.close()
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

// ── DCS airbase positions ─────────────────────────────────────────────────────

function runwaysDir() {
  return RUNWAYS_DIRS.find((d) => fs.existsSync(d)) ?? null
}

function runwayFiles(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() } catch { return [] }
}

// Fingerprint of the runway data and the offset limit, so a change to either
// re-runs the extract (parser.js compares it with the manifest's).
function airbaseCheckHash() {
  const hash = crypto.createHash('sha256').update(String(MAX_AIRPORT_OFFSET_KM))
  const dir = runwaysDir()
  if (dir) for (const f of runwayFiles(dir)) hash.update(f).update(fs.readFileSync(path.join(dir, f)))
  return hash.digest('hex').slice(0, 16)
}

// DCS airbase name -> { lat, lon }: the mean of its runways' reference points
function loadAirbasePositions() {
  const idx = {}
  const dir = runwaysDir()
  if (!dir) return idx
  for (const f of runwayFiles(dir)) {
    let j
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { continue }
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

// The theatre's mapped idents whose LNM airport is where DCS puts the
// airbase. An ident that can't be checked (no DCS runway data, or not in
// LNM) is kept. Skipped ones are logged with the distance.
function checkedIdents(db, tName, mapping, airbases) {
  const ok = new Set()
  const bad = new Map()   // ident -> "<DCS name> <km>"
  for (const [dcsName, ident] of Object.entries(mapping)) {
    const dcs = airbases[dcsName]
    const lnm = dcs ? queryOne(db, 'SELECT laty, lonx FROM airport WHERE ident = ?', [ident]) : null
    const km = lnm ? nmBetween(dcs.lat, dcs.lon, lnm.laty, lnm.lonx) * KM_PER_NM : null
    if (km === null || km <= MAX_AIRPORT_OFFSET_KM) ok.add(ident)
    else bad.set(ident, `${dcsName}, ${km.toFixed(1)} km`)
  }
  for (const [ident, why] of bad) {
    if (ok.has(ident)) continue
    console.log(`[extract] ${tName}: no LNM data for ${ident} - LNM's ${ident} isn't at the DCS airbase (${why} away)`)
  }
  return ok
}

async function runExtract(lnmDbPath) {
  if (!fs.existsSync(lnmDbPath)) {
    throw new Error(`LNM database not found: ${lnmDbPath}`)
  }

  const theatresRaw = fs.readFileSync(path.join(CONFIG_DIR, 'theatres.json'), 'utf8')
  const theatres    = JSON.parse(theatresRaw)
  const icaoMappingRaw = fs.readFileSync(ICAO_MAPPING_PATH, 'utf8')
  const icaoMapping  = JSON.parse(icaoMappingRaw)
  const bboxHash     = crypto.createHash('sha256').update(theatresRaw).digest('hex').slice(0, 16)
  const firIdentsRaw = fs.readFileSync(FIR_IDENTS_PATH, 'utf8')
  const firIdentsHash = crypto.createHash('sha256').update(firIdentsRaw).digest('hex').slice(0, 16)
  const icaoMappingHash = crypto.createHash('sha256').update(icaoMappingRaw).digest('hex').slice(0, 16)
  const airbaseHash  = airbaseCheckHash()
  const lnmStat      = fs.statSync(lnmDbPath)
  const lnmMtime     = lnmStat.mtime.toISOString()
  const lnmSize      = lnmStat.size

  console.log('[extract] loading LNM database...')
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs()
  const db  = new SQL.Database(fs.readFileSync(lnmDbPath))
  console.log('[extract] database loaded')

  await fsp.mkdir(CACHE_DIR, { recursive: true })

  // Mapped idents that pass the airbase position check, per theatre. Sector
  // frequencies are global, so an ident keeps them if it passes in any
  // theatre that maps it.
  const airbases = loadAirbasePositions()
  const okByTheatre = {}
  const allIcaos = new Set()
  for (const tName of Object.keys(theatres)) {
    okByTheatre[tName] = checkedIdents(db, tName, icaoMapping[tName.toLowerCase()] ?? {}, airbases)
    for (const icao of okByTheatre[tName]) allIcaos.add(icao)
  }

  // ── Per-theatre extraction ────────────────────────────────────────────────

  for (const [tName, tConf] of Object.entries(theatres)) {
    const folder  = path.join(CACHE_DIR, tConf.folder)
    // Rebuilt from scratch so an airport that no longer gets procedures
    // (unmapped, or failing the airbase check) doesn't keep a stale file.
    await fsp.rm(path.join(folder, 'procedures'), { recursive: true, force: true })
    await fsp.mkdir(path.join(folder, 'procedures'), { recursive: true })

    const bbox        = tConf.bbox
    const theatreKey  = tName.toLowerCase()
    const theatreIcaos = [...new Set(Object.values(icaoMapping[theatreKey] ?? {}))].filter((i) => okByTheatre[tName].has(i))

    console.log(`[extract] ${tName}: fixes, navaids, airspace, holdings, airways, MSA, MORA...`)

    const fixes    = extractFixes(db, bbox)
    const navaids  = extractNavaids(db, bbox)
    const airspace = extractAirspace(db, bbox)
    const holdings = extractHoldings(db, bbox)
    const airways  = extractAirways(db, bbox)
    const msa      = extractMsa(db, bbox)
    const mora     = extractMora(db, bbox)

    // Procedures per ICAO
    let procCount = 0
    for (const icao of theatreIcaos) {
      const airport = queryOne(db, 'SELECT airport_id FROM airport WHERE ident = ?', [icao])
      if (!airport) continue

      const procedures = extractProceduresForAirport(db, airport.airport_id)
      const total = Object.keys(procedures.SID).length
                  + Object.keys(procedures.STAR).length
                  + Object.keys(procedures.APPCH).length
      if (total === 0) continue

      await fsp.writeFile(
        path.join(folder, 'procedures', `${icao}.json`),
        JSON.stringify(procedures),
      )
      procCount++
    }

    const fc = airspace.features?.length ?? 0
    console.log(`[extract] ${tName}: ${fixes.length} fixes, ${navaids.length} navaids, ${fc} airspace features, ${holdings.length} holdings, ${mora.length} MORA cells, ${procCount} procedure files`)

    await Promise.all([
      fsp.writeFile(path.join(folder, 'fixes.json'),    JSON.stringify(fixes)),
      fsp.writeFile(path.join(folder, 'navaids.json'),  JSON.stringify(navaids)),
      fsp.writeFile(path.join(folder, 'airspace.json'), JSON.stringify(airspace)),
      fsp.writeFile(path.join(folder, 'holdings.json'), JSON.stringify(holdings)),
      fsp.writeFile(path.join(folder, 'airways.json'),  JSON.stringify(airways)),
      fsp.writeFile(path.join(folder, 'msa.json'),      JSON.stringify(msa)),
      fsp.writeFile(path.join(folder, 'mora.json'),     JSON.stringify(mora)),
    ])
  }

  // ── Global sectors ────────────────────────────────────────────────────────

  console.log('[extract] extracting sectors...')
  const sectors = extractSectors(db, allIcaos)
  console.log(`[extract] ${Object.keys(sectors).length} sectors`)

  // ctrs.json per theatre: FIR/UIR centers overlapping the theatre bbox
  const centerBoundaries = extractCenterBoundaries(db, JSON.parse(firIdentsRaw))
  for (const [_tName, tConf] of Object.entries(theatres)) {
    const folder = path.join(CACHE_DIR, tConf.folder)
    const ctrs = buildTheatreCenters(centerBoundaries, tConf.bbox)
    await fsp.writeFile(path.join(folder, 'ctrs.json'), JSON.stringify(ctrs))
  }

  await fsp.writeFile(path.join(CACHE_DIR, 'sectors.json'), JSON.stringify(sectors))

  db.close()

  const manifest = {
    extractVersion:  EXTRACT_VERSION,
    lnmMtime,
    lnmSize,
    bboxHash,
    firIdentsHash,
    icaoMappingHash,
    airbaseHash,
    builtAt:         new Date().toISOString(),
    proceduresBuilt: true,
  }
  await fsp.writeFile(path.join(CACHE_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log('[extract] done')
}

async function main() {
  const args  = process.argv.slice(2)
  const dpIdx = args.indexOf('--lnm-db-path')
  if (dpIdx === -1) {
    console.error('error: --lnm-db-path <path> is required (there is no default location)')
    console.error('usage: node server/navdata/tools/extract-navdata.js --lnm-db-path <path>')
    process.exit(1)
  }
  await runExtract(args[dpIdx + 1])
}

module.exports = { runExtract, validateLnmDb, airbaseCheckHash, EXTRACT_VERSION, ICAO_MAPPING_PATH }

if (require.main === module) {
  main().catch(err => { console.error('[extract] fatal:', err); process.exit(1) })
}
