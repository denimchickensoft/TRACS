/**
 * Live preview for an in-progress .line/.rect/.circ/.poly/.sect/.race/.text
 * draw command (AbmScope.jsx's pendingDraw state) — dashed/semi-transparent,
 * drawn on the same top contactsRef canvas RBL already uses. Reuses
 * drawAbmCustomDrawings.js's stroke/point primitives and drawShapes.js's
 * geometry builders so the preview always matches what actually gets
 * persisted on commit, just fed cursor-derived params instead of a click.
 *
 * Also shows a live dimension readout (length/mag heading, radius, leg
 * length, etc — whatever's meaningful per shape) until the shape is
 * anchored, in the same length/bearing label style RBL already uses
 * (drawAbmRbl.js): magnetic (declination-only, matching utils/bearing.js's
 * house convention), rounded, with a dark drop-shadow behind the text.
 */

import { latLngToCanvas } from '../../atc/stars/canvas/projection.js'
import { strokeLine, strokePolygon, drawPoint } from './drawAbmCustomDrawings.js'
import {
  buildLineFeature, buildRectFeature, buildCircFeature,
  buildSectFeature, buildRaceFeature,
} from '../../../utils/drawShapes.js'
import { toMagneticFromTrue } from '../../../utils/bearing.js'
import { previewParams } from '../draw/drawCommands.js'

const PREVIEW_COLOR   = '#FFFFFF'
const PREVIEW_OPACITY = 0.7
const PREVIEW_WIDTH   = 1.5
const PREVIEW_DASH    = [6, 4]

const BUILDERS = {
  line: buildLineFeature,
  rect: buildRectFeature,
  circ: buildCircFeature,
  sect: buildSectFeature,
  race: buildRaceFeature,
}

export function drawPendingDraw(ctx, view, pendingDraw, cursor) {
  if (!pendingDraw) return
  const declinationDeg = view.declinationDeg ?? 0
  const params = previewParams(pendingDraw, cursor, declinationDeg)
  if (!params) return

  if (pendingDraw.type === 'text') {
    drawTextPreview(ctx, view, params)
    return
  }
  // .poly is a freeform, not-yet-closed vertex chain — an open polyline
  // preview (plus a closing-edge hint), not a Polygon built via BUILDERS.
  if (pendingDraw.type === 'poly') {
    drawPolyPreview(ctx, view, params, declinationDeg)
    return
  }

  const built = BUILDERS[pendingDraw.type](params)
  if (built.geometry.type === 'LineString') {
    strokeLine(ctx, view, built.geometry.coordinates, PREVIEW_COLOR, PREVIEW_OPACITY, PREVIEW_WIDTH, PREVIEW_DASH)
  } else if (built.geometry.type === 'Polygon') {
    strokePolygon(ctx, view, [built.geometry.coordinates], PREVIEW_COLOR, PREVIEW_OPACITY, PREVIEW_WIDTH, PREVIEW_DASH, null, 0)
  }
  ctx.setLineDash([])

  drawDimensions(ctx, view, pendingDraw.type, params, built, declinationDeg)
}

// vertices = [...placed, liveCursorPoint] (previewParams already locked/
// snapped the cursor point the same way a click would commit it). Once 3+
// REAL vertices are down, also hints the closing edge back to vertex 0 —
// clicking near it (AbmScope.jsx's proximity test) is what actually closes
// the polygon.
function drawPolyPreview(ctx, view, { vertices, rangeNm, trueBearingDeg }, declinationDeg) {
  const placedCount = vertices.length - 1
  const coords = vertices.map(v => [v.lng, v.lat])
  if (placedCount >= 3) coords.push([vertices[0].lng, vertices[0].lat])
  strokeLine(ctx, view, coords, PREVIEW_COLOR, PREVIEW_OPACITY, PREVIEW_WIDTH, PREVIEW_DASH)
  ctx.setLineDash([])

  for (const v of vertices.slice(0, -1)) drawPoint(ctx, view, [v.lng, v.lat], PREVIEW_COLOR, PREVIEW_OPACITY)

  const last = vertices[vertices.length - 2]
  drawDimLabel(ctx, view, last, vertices[vertices.length - 1], lenBrgLabel(rangeNm, trueBearingDeg, declinationDeg))
}

// No marker dot — .text has none once committed either (drawAbmCustomDrawings.js),
// the placed point is the text's own centroid.
function drawTextPreview(ctx, view, { anchor, text, rotationDeg }) {
  const { x, y } = latLngToCanvas(anchor.lat, anchor.lng, view)
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(rotationDeg * Math.PI / 180)
  ctx.globalAlpha = PREVIEW_OPACITY
  ctx.fillStyle   = PREVIEW_COLOR
  ctx.font        = '9px "Roboto Mono", monospace'
  ctx.textAlign   = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 0, 0)
  ctx.restore()
  ctx.globalAlpha = 1
}

// ── Dimension readouts ───────────────────────────────────────────────────────
//
// These always read length/heading from the EXACT construction params
// (previewParams's return value) rather than re-measuring the rendered
// lat/lng points with trueBearingRangeNm. That formula references the
// AVERAGE latitude of its two input points — fine for a one-off range/
// bearing readout, but two points that are each independently projected
// from a shared origin (a rectangle's corners, a polygon's vertices) don't
// share that average, so re-deriving their separation this way makes
// genuinely-equal lengths (a rectangle's two parallel sides) read back as
// slightly different numbers. Building the label straight from the numbers
// that generated the shape sidesteps the whole problem.

function lenBrgLabel(rangeNm, trueBearingDeg, declinationDeg) {
  const magBrg = Math.round(toMagneticFromTrue(trueBearingDeg, declinationDeg)) || 360
  return `${String(magBrg).padStart(3, '0')}°M  ${Math.round(rangeNm)}NM`
}

function drawDimLabelAt(ctx, x, y, text) {
  ctx.font      = '10px "Roboto Mono", monospace'
  ctx.textAlign = 'center'
  ctx.fillStyle = 'rgba(0,0,0,0.45)'
  ctx.fillText(text, x + 1, y - 5)
  ctx.fillStyle   = PREVIEW_COLOR
  ctx.globalAlpha = 0.9
  ctx.fillText(text, x, y - 6)
  ctx.globalAlpha = 1
}

function drawDimLabel(ctx, view, fromLatLng, toLatLng, text) {
  const a = latLngToCanvas(fromLatLng.lat, fromLatLng.lng, view)
  const b = latLngToCanvas(toLatLng.lat, toLatLng.lng, view)
  drawDimLabelAt(ctx, (a.x + b.x) / 2, (a.y + b.y) / 2, text)
}

// Ring vertices as {lat,lng}, closing duplicate dropped — used to label
// .rect/.poly edge-by-edge (each edge gets its own length + mag heading,
// same as .line's single-segment label).
function ringPoints(built) {
  return built.geometry.coordinates[0].slice(0, -1).map(([lng, lat]) => ({ lat, lng }))
}

// .rect's exact width/height (previewParams.widthNm/heightNm) plus its
// rotationDeg fully determine every edge's length and TRUE heading with no
// lat/lng math at all: before rotation the "width" (east-pointing) edges
// sit at true bearing 090/270 and the "height" (north-pointing) edges at
// 000/180, so rotationDeg is added directly. Only the rendered ring's
// vertices are used, and only for where to place each label on screen.
function drawRectDims(ctx, view, params, built, declinationDeg) {
  const pts = ringPoints(built)
  const { widthNm, heightNm, rotationDeg } = params
  const widthBrg  = ((rotationDeg + 90) % 360 + 360) % 360
  const heightBrg = ((rotationDeg) % 360 + 360) % 360
  const lengths  = [widthNm, heightNm, widthNm, heightNm]
  const headings = [widthBrg, heightBrg, (widthBrg + 180) % 360, (heightBrg + 180) % 360]
  for (let i = 0; i < 4; i++) {
    drawDimLabel(ctx, view, pts[i], pts[(i + 1) % 4], lenBrgLabel(lengths[i], headings[i], declinationDeg))
  }
}

function drawDimensions(ctx, view, type, params, built, declinationDeg) {
  switch (type) {
    case 'line':
      drawDimLabel(ctx, view, params.p1, params.p2, lenBrgLabel(params.rangeNm, params.trueBearingDeg, declinationDeg))
      return
    case 'rect':
      drawRectDims(ctx, view, params, built, declinationDeg)
      return
    case 'circ': {
      const { x, y } = latLngToCanvas(params.center.lat, params.center.lng, view)
      drawDimLabelAt(ctx, x, y - 14, `R ${Math.round(params.radiusNm)}NM`)
      return
    }
    case 'sect': {
      const spanDeg = ((params.endBrg - params.startBrg) % 360 + 360) % 360
      const { x, y } = latLngToCanvas(params.center.lat, params.center.lng, view)
      drawDimLabelAt(ctx, x, y - 14, `${Math.round(params.radiusNm)}NM  ${Math.round(spanDeg)}°`)
      return
    }
    case 'race': {
      const magRad = Math.round(toMagneticFromTrue(params.radialDeg, declinationDeg)) || 360
      const { x, y } = latLngToCanvas(params.fix.lat, params.fix.lng, view)
      drawDimLabelAt(ctx, x, y - 14, `${params.turnDir} ${Math.round(params.legNm)}NM  ${String(magRad).padStart(3, '0')}°M`)
      return
    }
    default:
      return
  }
}
