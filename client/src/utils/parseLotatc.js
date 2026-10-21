// Parses a LotATC drawing layer export (`{ type: "layer", name, drawings }`)
// into user fixes plus normalized video-map features in the
// {geometry, properties, bbox, label} shape parseGeojson.js produces.
//
//   point    → fix (ID from `name`, falling back to `text`)
//   line     → LineString
//   polygon  → Polygon (LotATC stores an open ring; closed here)
//   circle   → Polygon approximating the circle (`radius` is in metres)
//   text     → labelled Point
//
// LotATC styling (color, colorBg, lineWidth, font, brushStyle) is dropped:
// video maps draw in the scope's own map colours. Unknown drawing types are
// counted and reported, not fatal.
//
// lotatcDrawingLayers() is ABM's import: a whole .env (several layers) or a
// single layer, one {name, features} per layer, with every shape (points
// included) as a styled, labelled feature.

import { computeBbox } from './parseGeojson.js'
import { buildCircFeature } from './drawShapes.js'
import { normalizeFixId, isValidLatLon } from './userFixes.js'

const METRES_PER_NM = 1852

export function isLotatcLayer(json) {
  return !!json && typeof json === 'object' && !Array.isArray(json) &&
    json.type === 'layer' && Array.isArray(json.drawings)
}

function toCoord(p) {
  const lat = Number(p?.latitude)
  const lon = Number(p?.longitude)
  return isValidLatLon(lat, lon) ? [lon, lat] : null
}

function feature(geometry, properties = {}, label = null) {
  return { geometry, properties, bbox: computeBbox(geometry), label }
}

// Returns { name, fixes: [{id, lat, lon}], features: [...], skipped: { [type]: count } }.
export function parseLotatc(json, fallbackName = 'LOTATC') {
  if (!isLotatcLayer(json)) throw new Error('Not a LotATC drawing layer')

  const fixes    = []
  const features = []
  const skipped  = {}
  const skip = (type) => { skipped[type] = (skipped[type] ?? 0) + 1 }

  for (const d of json.drawings) {
    const name = typeof d?.name === 'string' ? d.name.trim() : ''
    switch (d?.type) {
      case 'point': {
        const c  = toCoord(d)
        const id = normalizeFixId(name || d.text)
        if (!c || !id) { skip('point'); break }
        fixes.push({ id, lat: c[1], lon: c[0] })
        break
      }
      case 'text': {
        const c    = toCoord(d)
        const text = typeof d.text === 'string' ? d.text.trim() : ''
        if (!c || !text) { skip('text'); break }
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2)
        features.push(feature({ type: 'Point', coordinates: c }, { title: text }, lines))
        break
      }
      case 'line': {
        const coords = (d.points ?? []).map(toCoord).filter(Boolean)
        if (coords.length < 2) { skip('line'); break }
        features.push(feature({ type: 'LineString', coordinates: coords }, { name }))
        break
      }
      case 'polygon': {
        const ring = (d.points ?? []).map(toCoord).filter(Boolean)
        if (ring.length < 3) { skip('polygon'); break }
        const [first, last] = [ring[0], ring[ring.length - 1]]
        if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first)
        features.push(feature({ type: 'Polygon', coordinates: [ring] }, { name }))
        break
      }
      case 'circle': {
        const c        = toCoord(d)
        const radiusNm = Number(d.radius) / METRES_PER_NM
        if (!c || !(radiusNm > 0)) { skip('circle'); break }
        const circ = buildCircFeature({ center: { lat: c[1], lng: c[0] }, radiusNm })
        features.push({ ...circ, properties: { name } })
        break
      }
      default:
        skip(String(d?.type ?? 'unknown'))
    }
  }

  const layerName = typeof json.name === 'string' && json.name.trim() ? json.name.trim() : fallbackName
  return { name: layerName, fixes, features, skipped }
}

// A LotATC .env: { drawings: [layer, ...], version, enable }
export function isLotatcEnv(json) {
  return !!json && typeof json === 'object' && !Array.isArray(json) &&
    Array.isArray(json.drawings) && json.drawings.length > 0 && json.drawings.every(isLotatcLayer)
}

// '#AARRGGBB' -> { color: '#RRGGBB', opacity: 0..1 }, or null
function argb(value) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{6})$/i.exec(typeof value === 'string' ? value.trim() : '')
  return m ? { color: `#${m[2]}`, opacity: parseInt(m[1], 16) / 255 } : null
}

// GeoJSON-style properties from a LotATC drawing's styling: outline colour
// and width, and a fill when its background colour isn't fully transparent.
// ABM shows a feature's own width and fill; the outline colour seeds the
// layer's colour (store/abmDrawings.js addLayer).
function lotatcStyle(d, withFill) {
  const props = {}
  const stroke = argb(d.color)
  if (stroke) { props.stroke = stroke.color; props['stroke-opacity'] = stroke.opacity }
  const width = Number(d.lineWidth)
  if (width > 0) props['stroke-width'] = width
  const bg = withFill ? argb(d.colorBg) : null
  if (bg && bg.opacity > 0) { props.fill = bg.color; props['fill-opacity'] = bg.opacity }
  return props
}

function styledFeature(d) {
  const name  = typeof d?.name === 'string' ? d.name.trim() : ''
  const text  = typeof d?.text === 'string' ? d.text.trim() : ''
  const label = (text || name) ? (text || name).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2) : null
  switch (d?.type) {
    case 'point':
    case 'text': {
      const c = toCoord(d)
      return c && feature({ type: 'Point', coordinates: c }, { name: name || text, ...lotatcStyle(d, false) }, label)
    }
    case 'line': {
      const coords = (d.points ?? []).map(toCoord).filter(Boolean)
      return coords.length >= 2 && feature({ type: 'LineString', coordinates: coords }, { name, ...lotatcStyle(d, false) }, label)
    }
    case 'polygon': {
      const ring = (d.points ?? []).map(toCoord).filter(Boolean)
      if (ring.length < 3) return null
      const [first, last] = [ring[0], ring[ring.length - 1]]
      if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first)
      return feature({ type: 'Polygon', coordinates: [ring] }, { name, ...lotatcStyle(d, true) }, label)
    }
    case 'circle': {
      const c        = toCoord(d)
      const radiusNm = Number(d.radius) / METRES_PER_NM
      if (!c || !(radiusNm > 0)) return null
      const circ = buildCircFeature({ center: { lat: c[1], lng: c[0] }, radiusNm })
      return { ...circ, properties: { name, ...lotatcStyle(d, true) }, label }
    }
    default:
      return null
  }
}

// ABM drawing import: [{ name, features, skipped }] — one per LotATC layer
// in a .env, or one for a single exported layer.
export function lotatcDrawingLayers(json, fallbackName = 'LOTATC') {
  const layers = isLotatcEnv(json) ? json.drawings : isLotatcLayer(json) ? [json] : null
  if (!layers) throw new Error('Not a LotATC drawing file')
  return layers.map((layer, i) => {
    const features = []
    let skipped = 0
    for (const d of layer.drawings) {
      const f = styledFeature(d)
      if (f) features.push(f)
      else skipped++
    }
    const name = typeof layer.name === 'string' && layer.name.trim()
      ? layer.name.trim()
      : layers.length > 1 ? `${fallbackName} ${i + 1}` : fallbackName
    return { name, features, skipped }
  })
}
