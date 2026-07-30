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
 */

import { latLngToCanvas } from '../../atc/stars/canvas/projection.js'

const FALLBACK_COLOR = '#556677'

export function drawAbmAirspace(ctx, view, features, visibleCategories, brite = 80, dedupe = false, colors = null) {
  if (!features?.length) return
  const alpha = Math.max(0, Math.min(1, brite / 100))
  if (alpha <= 0) return

  const visibleFeatures = features.filter(f =>
    visibleCategories[f.displayCategory] && bboxInView(f.bbox, view))
  if (!visibleFeatures.length) return

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
