// Turns dropped/picked files into preview rows for the user navdata
// manager's IMPORT tab. Every file — or every entry of a .zip/.kmz, or every layer of
// a .miz — becomes its own row, parsed independently so one bad file doesn't
// block the rest:
//
//   { key, fileName, name, fixes, features, pointCandidates, pointsAsFixes,
//     closedLineCandidates, closedLinesAsPolygons, error }
//
// A procedure JSON file (see utils/userProcedures.js) instead becomes one
// row carrying `procs` (its procedure candidates) and nothing else, for the
// manager to hand to the PROCEDURES tab.
//
// `fixes` are explicit fixes (LotATC `point` drawings, CSV rows).
// `pointCandidates` counts named Point features in `features` that could be
// taken as fixes instead of drawn as map labels — `pointsAsFixes` is the
// default for that choice, which the user can flip per row before import.
// `closedLineCandidates` counts LineStrings that end where they start, which
// can import as Polygons (same outline, but fillable) — `closedLinesAsPolygons`,
// on by default. finalizeRow() applies both choices.

import { unzipSync } from 'fflate'
import { parseGeojson } from './parseGeojson.js'
import { parseMiz } from './parseMiz.js'
import { parseKml } from './parseKml.js'
import { parseLotatc, isLotatcLayer } from './parseLotatc.js'
import { normalizeFixId, isValidLatLon } from './userFixes.js'
import { parseProcedureJson } from './userProcedures.js'

const ZIP_ENTRY_EXT = /\.(json|geojson|ndgeojson|kml|kmz|csv)$/i

let _rowSeq = 0
const nextKey = () => `row${++_rowSeq}`

function baseName(path) {
  return path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '')
}

// ── CSV fixes ──────────────────────────────────────────────────────────────

// `ID,lat,lon` per line (comma, semicolon or tab separated). A header row,
// blank lines and `#` comments are skipped. Throws when nothing usable.
export function parseFixCsv(text) {
  const fixes = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const [id, lat, lon] = line.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''))
    const fixId = normalizeFixId(id)
    const la = Number(lat)
    const lo = Number(lon)
    if (!fixId || lat === '' || lon === '' || !isValidLatLon(la, lo)) continue
    fixes.push({ id: fixId, lat: la, lon: lo })
  }
  if (!fixes.length) throw new Error('No ID,lat,lon rows found')
  return fixes
}

// ── Named points → fixes ───────────────────────────────────────────────────

function pointName(f) {
  if (f.geometry?.type !== 'Point') return ''
  const p = f.properties ?? {}
  const n = p.name ?? p.ident ?? p.id ?? f.label?.[0]
  return typeof n === 'string' || typeof n === 'number' ? String(n).trim() : ''
}

function countNamedPoints(features) {
  return features.reduce((n, f) => n + (pointName(f) ? 1 : 0), 0)
}

// ── Closed lines → polygons ────────────────────────────────────────────────

// A LineString whose last vertex repeats its first (e.g. LotATC polygons
// exported as `line` drawings).
function isClosedLine(f) {
  if (f.geometry?.type !== 'LineString') return false
  const c = f.geometry.coordinates
  if (c.length < 4) return false
  const [a, b] = [c[0], c[c.length - 1]]
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9
}

function countClosedLines(features) {
  return features.reduce((n, f) => n + (isClosedLine(f) ? 1 : 0), 0)
}

// The fixes and map features a row will actually import.
export function finalizeRow(row) {
  const takePoints = row.pointsAsFixes && row.pointCandidates > 0
  const closeLines = row.closedLinesAsPolygons && row.closedLineCandidates > 0
  if (!takePoints && !closeLines) return { fixes: row.fixes, features: row.features }

  const fixes    = [...row.fixes]
  const features = []
  for (const f of row.features) {
    const id = takePoints ? normalizeFixId(pointName(f)) : ''
    if (id) {
      const [lon, lat] = f.geometry.coordinates
      fixes.push({ id, lat, lon })
    } else if (closeLines && isClosedLine(f)) {
      features.push({ ...f, geometry: { type: 'Polygon', coordinates: [f.geometry.coordinates] } })
    } else {
      features.push(f)
    }
  }
  return { fixes, features }
}

// ── Theatre sanity check ───────────────────────────────────────────────────

// Share (0–1) of a row's fixes and features lying outside `bbox`
// ([minLng, minLat, maxLng, maxLat]); features are judged by their bbox
// centre. null when the row has nothing to judge.
export function outsideShare(row, bbox) {
  if (!bbox) return null
  const [minLng, minLat, maxLng, maxLat] = bbox
  const outside = (lng, lat) => lng < minLng || lng > maxLng || lat < minLat || lat > maxLat
  let total = 0
  let out   = 0
  for (const f of row.fixes) { total++; if (outside(f.lon, f.lat)) out++ }
  for (const f of row.features) {
    if (!f.bbox) continue
    total++
    if (outside((f.bbox[0] + f.bbox[2]) / 2, (f.bbox[1] + f.bbox[3]) / 2)) out++
  }
  return total ? out / total : null
}

// ── Per-format parsing ─────────────────────────────────────────────────────

function makeRow(fileName, name, { fixes = [], features = [], pointsAsFixes = true }) {
  const pointCandidates      = countNamedPoints(features)
  const closedLineCandidates = countClosedLines(features)
  const row = {
    key: nextKey(), fileName, name, fixes, features,
    pointCandidates, pointsAsFixes: pointCandidates > 0 && pointsAsFixes,
    closedLineCandidates, closedLinesAsPolygons: closedLineCandidates > 0,
    error: null,
  }
  if (!fixes.length && !features.length) row.error = 'Nothing to import (empty layer)'
  return row
}

function errorRow(fileName, err) {
  return {
    key: nextKey(), fileName, name: baseName(fileName), fixes: [], features: [],
    pointCandidates: 0, pointsAsFixes: false, closedLineCandidates: 0, closedLinesAsPolygons: false,
    error: err?.message ?? String(err),
  }
}

function parseText(fileName, text) {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.csv')) {
    return [makeRow(fileName, baseName(fileName), { fixes: parseFixCsv(text) })]
  }
  if (lower.endsWith('.kml')) {
    const { name, features } = parseKml(text)
    return [makeRow(fileName, name || baseName(fileName), { features })]
  }
  // .json / .geojson / .ndgeojson: LotATC layer or GeoJSON
  let json = null
  try { json = JSON.parse(text) } catch { /* maybe newline-delimited GeoJSON */ }
  const procs = json != null ? parseProcedureJson(fileName, json) : null
  if (procs) {
    if (!procs.length) throw new Error('No procedures in file')
    return [{ ...makeRow(fileName, baseName(fileName), {}), procs, error: null }]
  }
  if (isLotatcLayer(json)) {
    const { name, fixes, features } = parseLotatc(json, baseName(fileName))
    // LotATC already separates fixes (`point`) from labels (`text`).
    return [makeRow(fileName, name, { fixes, features, pointsAsFixes: false })]
  }
  return [makeRow(fileName, baseName(fileName), { features: parseGeojson(text) })]
}

function kmlFromKmz(bytes) {
  const entries = unzipSync(bytes)
  const names = Object.keys(entries).filter((n) => /\.kml$/i.test(n))
  const pick = names.find((n) => /(^|\/)doc\.kml$/i.test(n)) ?? names[0]
  if (!pick) throw new Error('No .kml found inside .kmz')
  return new TextDecoder().decode(entries[pick])
}

// One row per drawing source in a mission's text (parseMiz's groups), named
// `<prefix> <group>`. Mission points are mostly text boxes/icons, so they
// stay map labels unless the user opts in. Each row keeps its `group` name.
export function missionMapRows(missionText, theatre, fileName, prefix) {
  return parseMiz(missionText, theatre).map((g) => ({
    ...makeRow(fileName, `${prefix} ${g.name}`, { features: g.features, pointsAsFixes: false }),
    group: g.name,
  }))
}

function parseBytes(fileName, bytes, theatre, skipped) {
  const lower = fileName.toLowerCase()
  try {
    if (lower.endsWith('.kmz')) {
      const { name, features } = parseKml(kmlFromKmz(bytes))
      return [makeRow(fileName, name || baseName(fileName), { features })]
    }
    if (lower.endsWith('.miz')) {
      const entries = unzipSync(bytes)
      if (!entries.mission) throw new Error('No "mission" file found inside .miz')
      return missionMapRows(new TextDecoder().decode(entries.mission), theatre, fileName, baseName(fileName))
    }
    if (lower.endsWith('.zip')) {
      const rows = []
      for (const [entryName, data] of Object.entries(unzipSync(bytes))) {
        if (entryName.endsWith('/') || entryName.startsWith('__MACOSX/')) continue
        if (!ZIP_ENTRY_EXT.test(entryName)) {
          if (!baseName(entryName).startsWith('.') && baseName(entryName)) skipped.push(entryName)
          continue
        }
        rows.push(...parseBytes(entryName, data, theatre, skipped))
      }
      return rows
    }
    if (/\.(json|geojson|ndgeojson|kml|csv)$/i.test(lower)) {
      return parseText(fileName, new TextDecoder().decode(bytes))
    }
    skipped.push(fileName)
    return []
  } catch (err) {
    return [errorRow(fileName, err)]
  }
}

// Returns { rows, skipped } — `skipped` lists file/entry names of formats
// that aren't importable (e.g. README.md, .py scripts, .xml).
export async function readImportFiles(fileList, theatre) {
  const rows    = []
  const skipped = []
  for (const file of Array.from(fileList ?? [])) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      rows.push(...parseBytes(file.name, bytes, theatre, skipped))
    } catch (err) {
      rows.push(errorRow(file.name, err))
    }
  }
  return { rows, skipped }
}
