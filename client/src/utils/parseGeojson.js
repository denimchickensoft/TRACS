// Parses/normalizes an arbitrary user-supplied GeoJSON file into the flat
// {geometry, properties, bbox, label} feature shape store/abmDrawings.js and
// canvas/drawAbmCustomDrawings.js expect — same flat shape server-built
// airspace features already use (see store/abmAirspace.js), except bbox is
// computed here client-side since there's no build step for user files.
//
// Permissive by design (2026-08-03 discussion): whatever geometry types or
// extra properties a file contains are kept as-is and handed to the draw
// layer, which decides what it knows how to render. The only failure mode
// is a file with no usable geometry at all — that throws, and the caller
// (AbmDrawingImport.jsx) surfaces it as an import error.

const GEOMETRY_TYPES = new Set([
  'Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon',
])

export function parseGeojson(text) {
  const raw = []

  try {
    // The common case: one JSON document (FeatureCollection/Feature/
    // GeometryCollection/bare geometry, however it's whitespace-formatted).
    collectFeatures(JSON.parse(text), raw)
  } catch {
    // Not a single JSON document — try newline-delimited GeoJSON (ndgeojson/
    // ndjson), where each line is its own Feature/geometry object. Lines
    // are parsed independently so a handful of bad ones don't sink an
    // otherwise-good file, matching the "corrupted bits get skipped, not
    // fatal" scope call.
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try { collectFeatures(JSON.parse(trimmed), raw) } catch { /* skip malformed line */ }
    }
  }

  if (!raw.length) throw new Error('No usable geometry found in file')

  return raw.map(({ geometry, properties }) => ({
    geometry,
    properties,
    bbox:  computeBbox(geometry),
    label: deriveLabel(properties),
  }))
}

// Walks a GeoJSON value (FeatureCollection / Feature / GeometryCollection /
// bare Geometry / a bare array of any of those) down to a flat list of
// {geometry, properties}, one entry per simple geometry.
function collectFeatures(node, out, properties = {}) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) collectFeatures(item, out, properties)
    return
  }
  switch (node.type) {
    case 'FeatureCollection':
      for (const f of node.features ?? []) collectFeatures(f, out, properties)
      break
    case 'Feature':
      if (node.geometry) collectFeatures(node.geometry, out, node.properties ?? {})
      break
    case 'GeometryCollection':
      for (const g of node.geometries ?? []) collectFeatures(g, out, properties)
      break
    default:
      if (GEOMETRY_TYPES.has(node.type) && node.coordinates) out.push({ geometry: node, properties })
  }
}

// [line1, line2], pulled from simplestyle-ish property keys — title takes
// the primary line, name the secondary, matching airspace's
// nameLabel/altLabel two-line convention (drawAbmAirspace.js). null when
// neither is present, so the draw layer skips labeling that feature.
function deriveLabel(properties) {
  const line1 = properties?.title ?? null
  const line2 = properties?.name  ?? null
  if (!line1 && !line2) return null
  return [line1, line2].filter(Boolean)
}

function computeBbox(geometry) {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
  walkCoords(geometry.coordinates, ([lng, lat]) => {
    if (lng < minLng) minLng = lng
    if (lat < minLat) minLat = lat
    if (lng > maxLng) maxLng = lng
    if (lat > maxLat) maxLat = lat
  })
  return [minLng, minLat, maxLng, maxLat]
}

// Recurses through nested coordinate arrays of any depth (Point is a bare
// [lng, lat] pair; MultiPolygon nests three levels deep) until it bottoms
// out at [lng, lat] pairs — one walk works for every geometry type.
function walkCoords(coords, visit) {
  if (typeof coords[0] === 'number') { visit(coords); return }
  for (const c of coords) walkCoords(c, visit)
}
