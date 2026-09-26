/**
 * Renders user-imported GeoJSON drawings for ABM (store/abmDrawings.js,
 * parsed by utils/parseGeojson.js). Deliberately not shared with
 * drawAbmAirspace.js — that file's data is server-built and polygon-only;
 * this handles arbitrary user files (any of Point/MultiPoint/LineString/
 * MultiLineString/Polygon/MultiPolygon) with per-feature simplestyle-ish
 * styling (`stroke-opacity`/`stroke-width`/`fill`/`fill-opacity`/
 * `marker-color`/`dash` properties, see utils/parseGeojson.js). Stroke COLOR
 * is layer-level, not per-feature (an imported file's
 * own per-feature `stroke` is only ever read once, at import time, to seed
 * the layer's color/override — see store/abmDrawings.js's addLayer): when
 * the layer's `colorOverride` is true, every feature paints with the
 * layer's `color` (Drawings panel swatch); when false, every feature paints
 * with the airspace palette's CUSTOM entry (server/navdata/config/
 * airspace_colors.json — see store/abmAirspace.js). A layer whose features
 * originally carried several different stroke colors collapses to one
 * uniform color on import — there is no longer a per-feature tier. Dash
 * stays palette-first (unaffected — only stroke COLOR moved to layer-level).
 *
 * `fillPct` (0-100, from the same `.fill` command that drives
 * drawAbmAirspace.js's polygon fill) gates every polygon fill pass here too
 * — explicit GeoJSON `fill` included, so importing a styled file no longer
 * shows fill until `.fill` is turned on. Fill color
 * priority mirrors stroke's: a feature's own `fill` wins, then — only when
 * `colorOverride` is true — the layer's color is reused verbatim as the
 * fill. That override tier deliberately does NOT fall back
 * to the CUSTOM palette's `stroke` the way drawAbmAirspace.js's fill does —
 * an unstyled shape only fills if airspace_colors.json's CUSTOM entry
 * actually defines a `fill` distinct from needing a stroke fallback; most
 * hand-drawn boundaries with no color of their own are meant as outlines,
 * not areas, so the palette tier stays conservative while override colors
 * (which the user explicitly chose) fill freely.
 *
 * Labels (feature.label, from parseGeojson's title/name convention) draw the
 * same way drawAbmAirspace.js draws airspace names — centroid placement for
 * round polygons, longest-straight-edge placement otherwise — plus simpler
 * placement for points (offset right of the marker) and lines (rotated text
 * at the line's midpoint by cumulative length). Gated by `labelsVisible`,
 * the same AbmScope `.labels` toggle that gates airspace labels — one
 * command controls both layers' names — EXCEPT when a layer's own
 * `labelOverride` is set (the Drawings panel's per-row "Label" checkbox),
 * which always shows that one layer's label regardless of the global
 * toggle. .text-command shapes (layer.shapeType === 'text') behave as if
 * permanently overridden — their label IS the shape's actual content
 * rather than an auxiliary name-tag, so it always renders (otherwise a
 * placed .text would show while being dragged into place, then vanish into
 * an unlabeled dot the moment it's committed, if `.labels` happened to be
 * off).
 */

import { latLngToCanvas } from '../../../utils/projection.js'

const MARKER_RADIUS = 3

export function drawAbmCustomDrawings(ctx, view, layers, customColors = null, labelsVisible = false, fillPct = 0, csMap = 2) {
  if (!layers?.length) return
  const visibleLayers = layers.filter(l => l.visible && l.features?.length)
  if (!visibleLayers.length) return

  const fontSize = 6 + csMap * 2
  const lineH    = fontSize + 3

  for (const layer of visibleLayers) {
    const visibleFeatures = layer.features.filter(f => bboxInView(f.bbox, view))
    if (!visibleFeatures.length) continue

    // Resolved once per layer, not per feature — colorOverride is a layer-
    // level flag (see file header), so every feature in this layer shares
    // the same override tier.
    const overrideColor = layer.colorOverride ? layer.color : null

    for (const f of visibleFeatures) drawFeature(ctx, view, f, overrideColor, customColors, layer.shapeType, fillPct)

    const showLabels = labelsVisible || layer.shapeType === 'text' || layer.labelOverride
    if (!showLabels) continue
    ctx.font         = `${fontSize}px "Roboto Mono", monospace`
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    for (const f of visibleFeatures) {
      if (f.label) drawLabel(ctx, view, f, overrideColor, customColors, fontSize, lineH, layer.shapeType)
    }
  }
  ctx.globalAlpha = 1
  ctx.setLineDash([])
}

function drawFeature(ctx, view, f, overrideColor, customColors, shapeType, fillPct) {
  const p = f.properties ?? {}
  // overrideColor (layer-level, resolved by the caller) is the same tier
  // used for fill priority below — non-null only when colorOverride is on.
  const stroke = overrideColor ?? customColors?.stroke
  const strokeOpacity = p['stroke-opacity'] ?? 1
  const strokeWidth   = p['stroke-width'] ?? 1.5
  // A geojson-authored dash is used as raw pixel values — there's no
  // real-world-distance convention for hand-drawn shapes. The palette's
  // CUSTOM.dash, by contrast, is defined in nm like every other airspace
  // category (server/navdata/config/airspace_colors.json), so it's scaled
  // by pixelsPerNm the same way drawAbmAirspace.js scales its dash arrays.
  const dash = (p.dash ?? p['stroke-dasharray'])
    ?? (customColors?.dash ?? []).map(v => v * view.pixelsPerNm)
  // fillPct <= 0 (the `.fill` command off) suppresses fill entirely,
  // including a feature's own explicit `fill` — see file header. Palette-tier
  // fill deliberately doesn't fall back to customColors?.stroke the way
  // drawAbmAirspace.js's does; an unstyled shape only fills if CUSTOM
  // actually defines one.
  const fill        = fillPct > 0 ? (p.fill ?? overrideColor ?? customColors?.fill ?? null) : null
  const fillOpacity = (p['fill-opacity'] ?? 0.2) * (fillPct / 100)

  switch (f.geometry.type) {
    // .text-command shapes (shapeType === 'text') are the label itself —
    // no marker dot, just the text centered on the point (see drawLabel).
    case 'Point':
      if (shapeType !== 'text') drawPoint(ctx, view, f.geometry.coordinates, p['marker-color'] ?? stroke, strokeOpacity)
      break
    case 'MultiPoint':
      if (shapeType !== 'text') {
        for (const c of f.geometry.coordinates) drawPoint(ctx, view, c, p['marker-color'] ?? stroke, strokeOpacity)
      }
      break
    case 'LineString':
      strokeLine(ctx, view, f.geometry.coordinates, stroke, strokeOpacity, strokeWidth, dash)
      break
    case 'MultiLineString':
      for (const line of f.geometry.coordinates) strokeLine(ctx, view, line, stroke, strokeOpacity, strokeWidth, dash)
      break
    case 'Polygon':
      strokePolygon(ctx, view, [f.geometry.coordinates], stroke, strokeOpacity, strokeWidth, dash, fill, fillOpacity)
      break
    case 'MultiPolygon':
      strokePolygon(ctx, view, f.geometry.coordinates, stroke, strokeOpacity, strokeWidth, dash, fill, fillOpacity)
      break
    default:
      // Unrecognized geometry type — silently skipped rather than thrown,
      // per the "flexible, cross that bridge later" scope decision.
  }
}

export function drawPoint(ctx, view, [lng, lat], color, opacity) {
  const { x, y } = latLngToCanvas(lat, lng, view)
  ctx.globalAlpha = opacity
  ctx.fillStyle   = color
  ctx.beginPath()
  ctx.arc(x, y, MARKER_RADIUS, 0, Math.PI * 2)
  ctx.fill()
}

export function strokeLine(ctx, view, coords, color, opacity, width, dash) {
  ctx.globalAlpha = opacity
  ctx.strokeStyle = color
  ctx.lineWidth   = width
  ctx.setLineDash(dash)
  ctx.beginPath()
  tracePath(ctx, view, coords)
  ctx.stroke()
  ctx.setLineDash([])
}

export function strokePolygon(ctx, view, polygons, color, opacity, width, dash, fill, fillOpacity) {
  if (fill) {
    ctx.globalAlpha = fillOpacity
    ctx.fillStyle   = fill
    for (const poly of polygons) {
      ctx.beginPath()
      for (const ring of poly) tracePath(ctx, view, ring)
      ctx.closePath()
      ctx.fill()
    }
  }
  ctx.globalAlpha = opacity
  ctx.strokeStyle = color
  ctx.lineWidth   = width
  ctx.setLineDash(dash)
  for (const poly of polygons) {
    ctx.beginPath()
    for (const ring of poly) tracePath(ctx, view, ring)
    ctx.stroke()
  }
  ctx.setLineDash([])
}

export function tracePath(ctx, view, ring) {
  ring.forEach(([lng, lat], i) => {
    const { x, y } = latLngToCanvas(lat, lng, view)
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
}

function drawLabel(ctx, view, f, overrideColor, customColors, fontSize, lineH, shapeType) {
  const p     = f.properties ?? {}
  const lines = f.label
  ctx.globalAlpha = 1
  ctx.fillStyle    = overrideColor ?? customColors?.stroke

  const type = f.geometry.type
  if (type === 'Point' || type === 'MultiPoint') {
    const coord = type === 'Point' ? f.geometry.coordinates : f.geometry.coordinates[0]
    const { x, y } = latLngToCanvas(coord[1], coord[0], view)
    // .text's middle-mouse rotation (AbmScope.jsx) lands here via
    // properties.labelRotationDeg — 0 for every other Point-geometry
    // feature, so this is a no-op rotation for those.
    const rotationRad = (p.labelRotationDeg ?? 0) * Math.PI / 180
    // .text has no marker dot to sit beside (drawFeature skips it) — the
    // placed point IS the text's centroid, not an offset-right label next
    // to a marker like every other Point feature's name-tag.
    const isTextShape = shapeType === 'text'
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(rotationRad)
    ctx.textAlign = isTextShape ? 'center' : 'left'
    const xOffset = isTextShape ? 0 : MARKER_RADIUS + 4
    lines.forEach((line, idx) => {
      ctx.fillText(line, xOffset, (idx - (lines.length - 1) / 2) * lineH)
    })
    ctx.restore()
    ctx.textAlign = 'center'
    return
  }

  if (type === 'LineString' || type === 'MultiLineString') {
    const line = type === 'LineString' ? f.geometry.coordinates : longestLine(f.geometry.coordinates)
    const mid  = midpointAlong(view, line)
    if (!mid) return
    ctx.save()
    ctx.translate(mid.mx, mid.my)
    ctx.rotate(mid.angle)
    lines.forEach((line2, idx) => {
      ctx.fillText(line2, 0, -(fontSize / 2 + 2) + (idx - (lines.length - 1) / 2) * lineH)
    })
    ctx.restore()
    return
  }

  // Polygon / MultiPolygon — same centroid-vs-edge placement as airspace
  // labels (drawAbmAirspace.js's drawLabels), ported rather than shared
  // since the two draw fns' feature shapes/use cases differ enough.
  const cLon = (f.bbox[0] + f.bbox[2]) / 2
  const cLat = (f.bbox[1] + f.bbox[3]) / 2

  if (isCircular(f.geometry, [cLon, cLat])) {
    const { x, y } = latLngToCanvas(cLat, cLon, view)
    lines.forEach((line, idx) => ctx.fillText(line, x, y + (idx - (lines.length - 1) / 2) * lineH))
    return
  }

  const minLenPx = ctx.measureText(lines[0]).width
  const edge = findLabelEdge(f.geometry, view, minLenPx)
  if (!edge) return
  const { mx, my, angle } = edge
  const { x: cx, y: cy } = latLngToCanvas(cLat, cLon, view)
  const inwardY   = -(cx - mx) * Math.sin(angle) + (cy - my) * Math.cos(angle)
  const halfBlock = fontSize / 2 + lineH * (lines.length - 1) / 2
  const baseOff   = Math.sign(inwardY || 1) * (halfBlock + 3)

  ctx.save()
  ctx.translate(mx, my)
  ctx.rotate(angle)
  lines.forEach((line, idx) => {
    ctx.fillText(line, 0, baseOff + (idx - (lines.length - 1) / 2) * lineH)
  })
  ctx.restore()
}

function longestLine(lines) {
  let best = lines[0], bestLen = -1
  for (const line of lines) {
    let len = 0
    for (let i = 1; i < line.length; i++) {
      len += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1])
    }
    if (len > bestLen) { bestLen = len; best = line }
  }
  return best
}

// Canvas-space midpoint by cumulative pixel length along a line, plus the
// local heading at that point (normalized to the upper semicircle so text
// never renders upside-down).
function midpointAlong(view, coords) {
  if (coords.length < 2) return null
  const pts = coords.map(([lng, lat]) => latLngToCanvas(lat, lng, view))
  const segLens = []
  let total = 0
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    segLens.push(d)
    total += d
  }
  if (total === 0) return null

  let target = total / 2
  for (let i = 0; i < segLens.length; i++) {
    if (target <= segLens[i] || i === segLens.length - 1) {
      const t = segLens[i] === 0 ? 0 : Math.min(1, target / segLens[i])
      const a = pts[i], b = pts[i + 1]
      let angle = Math.atan2(b.y - a.y, b.x - a.x)
      if (angle >  Math.PI / 2) angle -= Math.PI
      if (angle < -Math.PI / 2) angle += Math.PI
      return { mx: a.x + (b.x - a.x) * t, my: a.y + (b.y - a.y) * t, angle }
    }
    target -= segLens[i]
  }
  return null
}

// ── Polygon centroid/edge label placement — ported from
// drawAbmAirspace.js's drawLabels() ──────────────────────────────────────

// Coefficient of variation of vertex distances from centroid — low = circular.
function isCircular(geometry, centroid) {
  const [cLng, cLat] = centroid
  const cosLat = Math.cos(cLat * Math.PI / 180)
  const ring = geometry.type === 'Polygon'
    ? geometry.coordinates[0]
    : geometry.coordinates[0][0]
  const dists = ring.map(([lng, lat]) => {
    const dx = (lng - cLng) * cosLat
    const dy = lat - cLat
    return Math.sqrt(dx * dx + dy * dy)
  })
  const mean = dists.reduce((a, b) => a + b, 0) / dists.length
  if (mean === 0) return false
  const variance = dists.reduce((s, d) => s + (d - mean) ** 2, 0) / dists.length
  return Math.sqrt(variance) / mean < 0.05
}

// LNM two-pass longest near-straight run: try 5° tolerance then 30°.
// Returns null if no run meets minLenPx.
function findLabelEdge(geometry, view, minLenPx) {
  const polygons = geometry.type === 'Polygon'
    ? [geometry.coordinates]
    : geometry.coordinates

  let best = null
  for (const toleranceDeg of [5, 30]) {
    for (const poly of polygons) {
      const result = longestNearStraightRun(poly[0], view, toleranceDeg)
      if (result && (!best || result.len > best.len)) best = result
    }
    if (best && best.len >= minLenPx) break
  }
  return best && best.len >= minLenPx ? best : null
}

function longestNearStraightRun(ring, view, toleranceDeg) {
  const n = ring.length - 1  // closed ring: last vertex === first
  if (n < 2) return null

  const pts = []
  for (let i = 0; i < n; i++) {
    pts.push(latLngToCanvas(ring[i][1], ring[i][0], view))
  }

  const tol = toleranceDeg * Math.PI / 180

  const angles  = new Array(n)
  const lengths = new Array(n)
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const dx = pts[j].x - pts[i].x
    const dy = pts[j].y - pts[i].y
    angles[i]  = Math.atan2(dy, dx)
    lengths[i] = Math.hypot(dx, dy)
  }

  let bestLen = -1, bestStart = 0, bestEndNext = 1

  for (let i = 0; i < n; i++) {
    let runLen = lengths[i]
    let j = i
    for (let step = 1; step < n; step++) {
      const next = (j + 1) % n
      let diff = Math.abs(angles[next] - angles[i])
      if (diff > Math.PI) diff = 2 * Math.PI - diff
      if (diff > tol) break
      j = next
      runLen += lengths[j]
    }
    if (runLen > bestLen) {
      bestLen = runLen
      bestStart = i
      bestEndNext = (j + 1) % n
    }
  }

  const mx = (pts[bestStart].x + pts[bestEndNext].x) / 2
  const my = (pts[bestStart].y + pts[bestEndNext].y) / 2
  const dx = pts[bestEndNext].x - pts[bestStart].x
  const dy = pts[bestEndNext].y - pts[bestStart].y
  let angle = Math.atan2(dy, dx)
  if (angle >  Math.PI / 2) angle -= Math.PI
  if (angle < -Math.PI / 2) angle += Math.PI

  return { mx, my, angle, len: bestLen }
}

function bboxInView(bbox, view) {
  const [minLng, minLat, maxLng, maxLat] = bbox
  const tl = latLngToCanvas(maxLat, minLng, view)
  const br = latLngToCanvas(minLat, maxLng, view)
  return !(br.x < -50 || tl.x > view.width + 50 || tl.y > view.height + 50 || br.y < -50)
}
