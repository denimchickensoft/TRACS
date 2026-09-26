// Converts a DCS .miz mission's F10-map drawing geometry into ABM's
// normalized {geometry, properties, bbox, label} feature shape: reads the
// source schemas, converts DCS coordinates, and maps the result into ABM's
// drawing layer.
//
// Two independent sources are read:
//   - mission.triggers.zones   — quad (type 2) and circular (type 0) zones,
//     the common community "drawing via trigger zone" pattern. Other `type`
//     values (seen only in Foothold) are unconfirmed runtime bookkeeping,
//     not ME-authored shapes — skipped.
//   - mission.drawings.layers[].objects[] — the native ME Drawing tool
//     (Line/Polygon/TextBox/Icon), added ~DCS 2.9.
// Dynamic territory/frontier/connection overlays are deliberately
// out of scope — they exist only at runtime, built by a mission's own
// scripts from live capture state, and have no representation in the file.
//
// Returns one group per source (one "ZONES" group, plus one group per
// native Drawing layer that has content) rather than a single flat feature
// list: store/abmDrawings.js's addLayer() seeds a whole layer's stroke
// color from its first feature and collapses every other feature to that
// same color once colorOverride is on (see that file's addLayer comment) —
// grouping by source keeps a mission's Red/Blue/Neutral/Common/Author
// layers and its zone geometry each in their own recolorable layer instead
// of every color in the file collapsing into one.

import { parseLuaAssignment, sortedValues } from './luaTable.js'
import { dcsPointToLatLng } from './dcsCoords.js'
import { getProjectionParams } from './magvar.js'
import { destinationPoint } from './bearing.js'
import { computeBbox } from './parseGeojson.js'

const CIRCLE_STEP_DEG = 5
const OVAL_STEPS = 36

// ── color decoding ──────────────────────────────────────────────────────

// Zone / runtime-markup-API colors: {1:r,2:g,3:b,4:a} (Lua-positional, so
// really just [r,g,b,a] after sortedValues), floats 0..1.
function zoneColorToRgba(colorObj) {
  const [r, g, b, a] = sortedValues(colorObj)
  if (r == null) return null
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a ?? 1})`
}

// Native Drawing colorString/fillColorString: "0xRRGGBBAA", bytes 0..255
// (confirmed against pydcs's own Rgba.to/from_color_string).
function hexToRgba(hex) {
  if (typeof hex !== 'string') return null
  const h = hex.replace(/^0x/i, '').replace(/^#/, '')
  if (h.length < 8) return null
  const [r, g, b, a] = [0, 2, 4, 6].map(i => parseInt(h.slice(i, i + 2), 16))
  return `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`
}

// ── geometry helpers ────────────────────────────────────────────────────

// Rotates a local (northOff, eastOff) meter offset by angleDeg, matching
// utils/drawShapes.js's offsetPoint/destinationPoint bearing convention
// (rotationDeg added to bearing = clockwise rotation of the east/north
// vector) so ME `angle` fields (rect/oval) behave the same way.
function rotateOffset(northOff, eastOff, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return {
    north: eastOff * sin + northOff * cos,
    east: eastOff * cos - northOff * sin,
  }
}

function tessellateCircleAt(lat, lng, radiusNm) {
  const ring = []
  for (let brg = 0; brg < 360; brg += CIRCLE_STEP_DEG) {
    const p = destinationPoint(lat, lng, brg, radiusNm)
    ring.push([p.lng, p.lat])
  }
  ring.push(ring[0])
  return ring
}

function makeFeature(geometry, properties, label) {
  return { geometry, properties, bbox: computeBbox(geometry), label: label ?? null }
}

// ── Trigger-zone shapes ─────────────────────────────────────────────────

function buildZoneFeature(zone, project) {
  const name = typeof zone.name === 'string' ? zone.name : null
  const stroke = zoneColorToRgba(zone.color)
  const properties = stroke ? { stroke } : {}

  if (zone.type === 2) {
    const verts = sortedValues(zone.verticies)
    if (verts.length < 3) return null
    const ring = verts.map(v => project(v.x ?? 0, v.y ?? 0))
    ring.push(ring[0])
    return makeFeature({ type: 'Polygon', coordinates: [ring] }, properties, name ? [name] : null)
  }

  if (zone.type === 0) {
    const [lng, lat] = project(zone.x ?? 0, zone.y ?? 0)
    const radiusNm = (zone.radius ?? 0) / 1852
    const ring = tessellateCircleAt(lat, lng, radiusNm)
    return makeFeature({ type: 'Polygon', coordinates: [ring] }, properties, name ? [name] : null)
  }

  // type 1/4 etc — unconfirmed, likely script-injected bookkeeping, not
  // ME-authored geometry. Skip.
  return null
}

// ── Native Drawing objects ────────────────────────────────────────────

function buildPolygonRing(obj, mapX, mapY, project) {
  switch (obj.polygonMode) {
    case 'circle': {
      const [lng, lat] = project(mapX, mapY)
      return tessellateCircleAt(lat, lng, (obj.radius ?? 0) / 1852)
    }
    case 'oval': {
      const angle = obj.angle ?? 0
      const r1 = obj.r1 ?? 0
      const r2 = obj.r2 ?? 0
      const ring = []
      for (let i = 0; i <= OVAL_STEPS; i++) {
        const th = (2 * Math.PI * i) / OVAL_STEPS
        const { north, east } = rotateOffset(r1 * Math.cos(th), r2 * Math.sin(th), angle)
        ring.push(project(mapX + north, mapY + east))
      }
      return ring
    }
    case 'rect': {
      const angle = obj.angle ?? 0
      const halfW = (obj.width ?? 0) / 2
      const halfH = (obj.height ?? 0) / 2
      // width = east-west extent, height = north-south extent — not
      // confirmed against real content, but the
      // natural reading of a north-up ME dialog's "Width"/"Height" labels.
      const localCorners = [[-halfW, -halfH], [halfW, -halfH], [halfW, halfH], [-halfW, halfH]]
      const ring = localCorners.map(([east, north]) => {
        const r = rotateOffset(north, east, angle)
        return project(mapX + r.north, mapY + r.east)
      })
      ring.push(ring[0])
      return ring
    }
    case 'free':
    case 'arrow': {
      // Both store their full outline as absolute-offset points — an
      // arrow's `angle`/`length` are reconstruction metadata only, the
      // points already encode the final shape.
      const pts = sortedValues(obj.points)
      if (pts.length < 3) return null
      const ring = pts.map(p => project(mapX + (p.x ?? 0), mapY + (p.y ?? 0)))
      ring.push(ring[0])
      return ring
    }
    default:
      return null
  }
}

function buildDrawingFeature(obj, project) {
  const name = typeof obj.name === 'string' ? obj.name : null
  const label = name ? [name] : null
  const stroke = hexToRgba(obj.colorString)
  const fill = hexToRgba(obj.fillColorString)
  const properties = {}
  if (stroke) properties.stroke = stroke
  if (fill) properties.fill = fill

  const mapX = obj.mapX ?? 0
  const mapY = obj.mapY ?? 0

  switch (obj.primitiveType) {
    case 'Line': {
      const pts = sortedValues(obj.points).map(p => project(mapX + (p.x ?? 0), mapY + (p.y ?? 0)))
      if (pts.length < 2) return null
      if (obj.closed) {
        const ring = [...pts, pts[0]]
        return makeFeature({ type: 'Polygon', coordinates: [ring] }, properties, label)
      }
      return makeFeature({ type: 'LineString', coordinates: pts }, properties, label)
    }
    case 'Polygon': {
      const ring = buildPolygonRing(obj, mapX, mapY, project)
      if (!ring || ring.length < 4) return null
      return makeFeature({ type: 'Polygon', coordinates: [ring] }, properties, label)
    }
    case 'TextBox': {
      const geometry = { type: 'Point', coordinates: project(mapX, mapY) }
      const text = typeof obj.text === 'string' ? obj.text : ''
      properties.title = text
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 2)
      return makeFeature(geometry, properties, lines.length ? lines : label)
    }
    case 'Icon': {
      const geometry = { type: 'Point', coordinates: project(mapX, mapY) }
      if (typeof obj.file === 'string') properties.icon = obj.file
      return makeFeature(geometry, properties, label)
    }
    default:
      return null
  }
}

// ── top-level entry point ───────────────────────────────────────────────

/**
 * Parses a .miz's raw `mission` file text into ABM drawing layers.
 * `fallbackTheatre` (the ABM scope's current theatre) is used when the
 * mission's own `theatre` field is missing or unrecognized.
 *
 * Returns `[{ name, features }, ...]` — the caller (AbmDrawingImport.jsx)
 * treats each entry exactly like one dropped GeoJSON file, so it gets the
 * same preview/rename/import flow as any other import.
 */
export function parseMiz(missionText, fallbackTheatre = null) {
  const root = parseLuaAssignment(missionText, 'mission')
  if (!root || typeof root !== 'object') {
    throw new Error('Not a DCS mission file (no `mission = { ... }` table found)')
  }

  const missionTheatre = typeof root.theatre === 'string' ? root.theatre : null
  const theatre = missionTheatre && getProjectionParams(missionTheatre) ? missionTheatre : fallbackTheatre
  if (!theatre || !getProjectionParams(theatre)) {
    throw new Error(`Unknown theatre "${missionTheatre ?? fallbackTheatre ?? '?'}" — no projection parameters available`)
  }

  function project(x, y) {
    const p = dcsPointToLatLng(x, y, theatre)
    if (!p) throw new Error('Projection failed')
    return [p.lng, p.lat]
  }

  const groups = []

  const zoneFeatures = []
  for (const zone of sortedValues(root.triggers?.zones)) {
    try {
      const f = buildZoneFeature(zone, project)
      if (f) zoneFeatures.push(f)
    } catch { /* one malformed zone shouldn't sink the rest of the import */ }
  }
  if (zoneFeatures.length) groups.push({ name: 'ZONES', features: zoneFeatures })

  for (const layer of sortedValues(root.drawings?.layers)) {
    const layerFeatures = []
    for (const obj of sortedValues(layer.objects)) {
      try {
        const f = buildDrawingFeature(obj, project)
        if (f) layerFeatures.push(f)
      } catch { /* one malformed object shouldn't sink the rest of the import */ }
    }
    if (layerFeatures.length) {
      const name = typeof layer.name === 'string' && layer.name ? layer.name.toUpperCase() : 'DRAWING'
      groups.push({ name, features: layerFeatures })
    }
  }

  if (!groups.length) throw new Error('No importable zones or drawings found in this mission')
  return groups
}
