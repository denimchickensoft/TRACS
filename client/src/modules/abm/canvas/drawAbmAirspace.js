/**
 * Renders airspace polygon boundaries theatre-wide for ABM. Unlike STARS'
 * drawMaps (client/src/modules/atc/stars/canvas/drawMaps.js), this takes flat,
 * unbucketed features straight from the server response — ABM has no
 * facility to envelope-bucket around and no DCB slots to assign, it just
 * toggles whole categories (.tma/.ctr/.asp/etc, see AbmScope's asVisible).
 *
 * `dedupe = false` strokes every feature's rings independently, so adjacent
 * regions each draw their own shared border rather than merging into one
 * traced outline. Flip `dedupe = true` to fall back to drawMaps' behavior —
 * collectEdges/edgeKey below are copied verbatim from drawMaps.js for that.
 *
 * `colors` is one palette's `{ [displayCategory]: { stroke, dash, ... } }` map
 * from airspace_colors.json (see store/abmAirspace.js — fetched independently
 * of useMapsStore's palette state, which is STARS-only). Falls back to
 * FALLBACK_COLOR/solid-line per-feature when a category has no entry. `dash`
 * is scaled by view.pixelsPerNm, same convention as drawMaps.js.
 *
 * `labelsVisible` (AbmScope's `.labels` toggle) draws each feature's
 * nameLabel/altLabel — see drawLabels() below, which defers placement
 * (anchor geometry + collision nudging against overlapping sectors) to the
 * shared utils/airspaceLabelPlacement.js, also used by drawMaps.js. Labels
 * only ever appear for features already passing the visibleCategories
 * filter above, so they track the .tma/.classc/etc category toggles
 * automatically.
 *
 * `fillPct` (0-100, from the `.fill` command) draws a filled-polygon pass
 * before the stroke pass, using each category's `fill` color (falls back to
 * `stroke`, then FALLBACK_COLOR) — same convention as drawMaps.js's
 * polygonFill. 0 (the default) skips the pass entirely.
 */

import { latLngToCanvas } from '../../../utils/projection.js'
import { placeAirspaceLabels } from '../../../utils/airspaceLabelPlacement.js'

const FALLBACK_COLOR = '#556677'

export function drawAbmAirspace(ctx, view, features, visibleCategories, brite = 80, dedupe = false, colors = null, labelsVisible = false, fillPct = 0) {
  if (!features?.length) return
  const alpha = Math.max(0, Math.min(1, brite / 100))
  if (alpha <= 0) return

  const visibleFeatures = features.filter(f =>
    visibleCategories[f.displayCategory] && bboxInView(f.bbox, view))
  if (!visibleFeatures.length) return

  // Fill pass — closed polygon area, grouped by category so each keeps its
  // own fill color.
  if (fillPct > 0) {
    const byCategory = new Map()
    for (const f of visibleFeatures) {
      if (!byCategory.has(f.displayCategory)) byCategory.set(f.displayCategory, [])
      byCategory.get(f.displayCategory).push(f)
    }
    ctx.globalAlpha = alpha * (fillPct / 100)
    for (const [category, feats] of byCategory) {
      ctx.fillStyle = colors?.[category]?.fill ?? colors?.[category]?.stroke ?? FALLBACK_COLOR
      for (const f of feats) drawFill(ctx, view, f)
    }
  }

  ctx.globalAlpha = alpha
  ctx.lineWidth   = 1.0

  if (dedupe) {
    // Group by category first, same as drawMaps.js's per-category loop — edges
    // are only deduped within a category, so each keeps its own color/dash.
    const byCategory = new Map()
    for (const f of visibleFeatures) {
      if (!byCategory.has(f.displayCategory)) byCategory.set(f.displayCategory, [])
      byCategory.get(f.displayCategory).push(f)
    }
    for (const [category, feats] of byCategory) {
      ctx.strokeStyle = colors?.[category]?.stroke ?? FALLBACK_COLOR
      ctx.setLineDash((colors?.[category]?.dash ?? []).map(v => v * view.pixelsPerNm))
      const edgeMap = new Map()
      for (const f of feats) collectEdges(f, edgeMap)
      ctx.beginPath()
      for (const [p1, p2] of edgeMap.values()) {
        const a = latLngToCanvas(p1[1], p1[0], view)
        const b = latLngToCanvas(p2[1], p2[0], view)
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
      }
      ctx.stroke()
    }
  } else {
    for (const f of visibleFeatures) {
      ctx.strokeStyle = colors?.[f.displayCategory]?.stroke ?? FALLBACK_COLOR
      ctx.setLineDash((colors?.[f.displayCategory]?.dash ?? []).map(v => v * view.pixelsPerNm))
      strokeFeature(ctx, view, f)
    }
  }

  ctx.setLineDash([])
  ctx.globalAlpha = 1.0

  if (labelsVisible) drawLabels(ctx, view, visibleFeatures, colors, alpha)
}

// Renders each feature's nameLabel/altLabel (same fields STARS' drawMaps.js
// reads). Anchor geometry (centroid vs. longest near-straight edge) and
// collision-avoidance nudging are shared with drawMaps.js via
// utils/airspaceLabelPlacement.js — only text measurement/sizing stays
// local, since STARS sizes text off csMap/briteMapB (DCB knobs ABM has no
// equivalent of) while ABM uses a fixed font size at the geometry pass'
// alpha. `visibleFeatures` is already filtered to on-toggle categories, so
// labels inherit that for free.
function drawLabels(ctx, view, visibleFeatures, colors, alpha) {
  const fontSize = 9
  const lineH    = fontSize + 3
  ctx.font         = `${fontSize}px "Roboto Mono", monospace`
  ctx.textAlign    = 'center'
  ctx.textBaseline = 'middle'

  const items = []
  for (const f of visibleFeatures) {
    const label1 = f.isParent ? (f.nameLabel ?? null) : null
    const label2 = f.altLabel ?? null
    if (!label1 && !label2) continue

    const lines = [label1, label2].filter(Boolean)
    const color = colors?.[f.displayCategory]?.stroke ?? FALLBACK_COLOR
    items.push({ feature: f, lines, lineWidths: lines.map(l => ctx.measureText(l).width), fontSize, color })
  }

  ctx.globalAlpha = alpha
  for (const { lines, x, y, angle, color } of placeAirspaceLabels(items, view)) {
    ctx.fillStyle = color
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(angle)
    lines.forEach((line, idx) => {
      ctx.fillText(line, 0, (idx - (lines.length - 1) / 2) * lineH)
    })
    ctx.restore()
  }
  ctx.globalAlpha = 1.0
}

// Draw filled polygon area for a feature (no stroke). Copied verbatim from
// drawMaps.js's drawFill.
function drawFill(ctx, view, feature) {
  const polygons = feature.geometry.type === 'Polygon'
    ? [feature.geometry.coordinates]
    : feature.geometry.coordinates

  for (const poly of polygons) {
    ctx.beginPath()
    const ring = poly[0]
    for (let j = 0; j < ring.length - 1; j++) {
      const [lng, lat] = ring[j]
      const { x, y } = latLngToCanvas(lat, lng, view)
      if (j === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.fill()
  }
}

// Strokes one feature's rings independently of every other feature.
function strokeFeature(ctx, view, feature) {
  const polygons = feature.geometry.type === 'Polygon'
    ? [feature.geometry.coordinates]
    : feature.geometry.coordinates

  ctx.beginPath()
  for (const poly of polygons) {
    for (const ring of poly) {
      for (let j = 0; j < ring.length; j++) {
        const [lng, lat] = ring[j]
        const { x, y } = latLngToCanvas(lat, lng, view)
        if (j === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
    }
  }
  ctx.stroke()
}

// Collect all edges from a feature into edgeMap, keyed canonically so that
// an edge shared between two adjacent polygons is stored only once.
function collectEdges(feature, edgeMap) {
  const polygons = feature.geometry.type === 'Polygon'
    ? [feature.geometry.coordinates]
    : feature.geometry.coordinates

  for (const poly of polygons) {
    const ring = poly[0]
    const n = ring.length - 1  // GeoJSON closed rings duplicate the first vertex at the end
    for (let j = 0; j < n; j++) {
      const p1 = ring[j]
      const p2 = ring[(j + 1) % n]
      const key = edgeKey(p1, p2)
      if (!edgeMap.has(key)) edgeMap.set(key, [p1, p2])
    }
  }
}

// Canonical edge key: always orders the two endpoints the same way regardless
// of which polygon contributed the edge and in which direction.
function edgeKey(p1, p2) {
  const [lng1, lat1] = p1
  const [lng2, lat2] = p2
  return lng1 < lng2 || (lng1 === lng2 && lat1 < lat2)
    ? `${lng1},${lat1},${lng2},${lat2}`
    : `${lng2},${lat2},${lng1},${lat1}`
}

function bboxInView(bbox, view) {
  const [minLng, minLat, maxLng, maxLat] = bbox
  const tl = latLngToCanvas(maxLat, minLng, view)
  const br = latLngToCanvas(minLat, maxLng, view)
  return !(br.x < -50 || tl.x > view.width + 50 || tl.y > view.height + 50 || br.y < -50)
}
