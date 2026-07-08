import { latLngToCanvas, canvasToLatLng } from '../../atc/stars/canvas/projection.js'
import { tmForward, tmInverse } from '../../../utils/transverseMercator.js'
import { utmZoneNumber, utmZoneParams, mgrs100kSquareId, latBand } from '../../../utils/mgrs.js'

const SQUARE_M = 100000
const GRID_COLOR     = '#33CC33'
const FINE_COLOR     = '#227722'
const LABEL_COLOR    = '#55EE55'
const BOUNDARY_COLOR = '#FFCC00'

// Real UTM-zone grid lines are only exactly straight in that zone's own TM
// frame; once reprojected through DCS's theatre TM + magvar rotation
// (projection.js) they bow slightly, so each drawn line is sampled and
// rendered as a polyline rather than a single straight segment.
const CURVE_STEPS = 12

// How finely the split meridian is sampled for the clip path, and how far
// past the screen's visible lat/lng range the clip is padded so it fully
// contains the rotated (magvar) screen rectangle.
const MERIDIAN_STEPS = 20
const LAT_PAD = 5
const LNG_MARGIN = 20

// Real UTM zone boundary this map straddles — Syria spans zones 36 and 37,
// split at 36°E. West of it is zone 36 (Ben Gurion, Beirut, Incirlik); east
// is zone 37 (Damascus, Shayrat, Tiyas — also DCS's own theatre central
// meridian, 39°E). Fixed rather than derived, per 2026-07-07: deriving a
// single zone from the view center kept whichever area was off-screen wrong
// (Ben Gurion showed square AR instead of its real XA when the view was
// centered near Damascus); splitting at the true boundary keeps both sides
// correct at once, at the cost of the same real seam DCS's own F10 map shows
// at this exact line.
const SPLIT_LNG  = 36
const WEST_ZONE  = utmZoneNumber(SPLIT_LNG - 0.001)
const EAST_ZONE  = utmZoneNumber(SPLIT_LNG + 0.001)

function fineSpacingFor(rangeNm) {
  if (rangeNm <= 20)  return 1000
  if (rangeNm <= 100) return 10000
  return 0 // no sub-grid at wide ranges — the 100km lines are enough
}

// Corners + edge midpoints, so a rotated (magvar) view is still bounded
// correctly.
function screenSamples(width, height) {
  return [
    [0, 0], [width / 2, 0], [width, 0],
    [0, height / 2], [width, height / 2],
    [0, height], [width / 2, height], [width, height],
  ]
}

function strokePolyline(ctx, pts) {
  ctx.beginPath()
  pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y))
  ctx.stroke()
}

function sampleLine(fixed, varyMin, varyMax, params, vertical, view) {
  const pts = []
  for (let i = 0; i <= CURVE_STEPS; i++) {
    const v = varyMin + (varyMax - varyMin) * i / CURVE_STEPS
    const easting  = vertical ? fixed : v
    const northing = vertical ? v : fixed
    const { lat, lng } = tmInverse(easting, northing, params)
    pts.push(latLngToCanvas(lat, lng, view))
  }
  return pts
}

// Clips the canvas to the half of the screen west or east of SPLIT_LNG. The
// meridian itself isn't straight on screen (DCS TM + magvar rotation), so
// it's traced as a polyline; the far side is closed off well past the
// screen's visible longitude range so the whole half is covered regardless
// of zoom/pan/rotation.
function clipHalf(ctx, view, side, minLat, maxLat) {
  const lo = minLat - LAT_PAD
  const hi = maxLat + LAT_PAD
  const farLng = side === 'west' ? SPLIT_LNG - LNG_MARGIN : SPLIT_LNG + LNG_MARGIN

  ctx.beginPath()
  if (side === 'west') {
    for (let i = 0; i <= MERIDIAN_STEPS; i++) {
      const lat = hi - (hi - lo) * i / MERIDIAN_STEPS
      const { x, y } = latLngToCanvas(lat, SPLIT_LNG, view)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    const p1 = latLngToCanvas(lo, farLng, view)
    const p2 = latLngToCanvas(hi, farLng, view)
    ctx.lineTo(p1.x, p1.y)
    ctx.lineTo(p2.x, p2.y)
  } else {
    for (let i = 0; i <= MERIDIAN_STEPS; i++) {
      const lat = lo + (hi - lo) * i / MERIDIAN_STEPS
      const { x, y } = latLngToCanvas(lat, SPLIT_LNG, view)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    const p1 = latLngToCanvas(hi, farLng, view)
    const p2 = latLngToCanvas(lo, farLng, view)
    ctx.lineTo(p1.x, p1.y)
    ctx.lineTo(p2.x, p2.y)
  }
  ctx.closePath()
  ctx.clip()
}

// Draws the true zone boundary meridian itself, unclipped, so it's visible
// across both zones' territory rather than stopping at either one's clip.
function drawBoundaryLine(ctx, view, minLat, maxLat) {
  const lo = minLat - LAT_PAD
  const hi = maxLat + LAT_PAD
  ctx.save()
  ctx.strokeStyle = BOUNDARY_COLOR
  ctx.lineWidth = 1.5
  ctx.setLineDash([])
  const pts = []
  for (let i = 0; i <= MERIDIAN_STEPS; i++) {
    const lat = lo + (hi - lo) * i / MERIDIAN_STEPS
    pts.push(latLngToCanvas(lat, SPLIT_LNG, view))
  }
  strokePolyline(ctx, pts)
  ctx.restore()
}

function drawZoneGrid(ctx, view, zone, hemisphere, fineSpacing, labelEastingFloor) {
  const { width, height } = view
  const params = utmZoneParams(zone, hemisphere)

  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity
  for (const [x, y] of screenSamples(width, height)) {
    const { lat, lng } = canvasToLatLng(x, y, view)
    const { easting, northing } = tmForward(lat, lng, params)
    minE = Math.min(minE, easting); maxE = Math.max(maxE, easting)
    minN = Math.min(minN, northing); maxN = Math.max(maxN, northing)
  }
  if (!Number.isFinite(minE) || !Number.isFinite(minN)) return

  // ── Fine subdivision lines (10km or 1km, depending on zoom) ───────────────
  if (fineSpacing) {
    ctx.strokeStyle = FINE_COLOR
    ctx.setLineDash([4, 4])
    ctx.lineWidth = 0.5

    const eStart = Math.floor(minE / fineSpacing - 1) * fineSpacing
    const eEnd   = Math.ceil (maxE / fineSpacing + 1) * fineSpacing
    for (let e = eStart; e <= eEnd; e += fineSpacing) {
      if (e % SQUARE_M === 0) continue
      strokePolyline(ctx, sampleLine(e, minN, maxN, params, true, view))
    }

    const nStart = Math.floor(minN / fineSpacing - 1) * fineSpacing
    const nEnd   = Math.ceil (maxN / fineSpacing + 1) * fineSpacing
    for (let nrth = nStart; nrth <= nEnd; nrth += fineSpacing) {
      if (nrth % SQUARE_M === 0) continue
      strokePolyline(ctx, sampleLine(nrth, minE, maxE, params, false, view))
    }
    ctx.setLineDash([])
  }

  // ── 100km grid lines — always shown when the layer is on ─────────────────
  ctx.strokeStyle = GRID_COLOR
  ctx.lineWidth = 1

  const eStart = Math.floor(minE / SQUARE_M - 1) * SQUARE_M
  const eEnd   = Math.ceil (maxE / SQUARE_M + 1) * SQUARE_M
  const vLines = []
  for (let e = eStart; e <= eEnd; e += SQUARE_M) {
    vLines.push(e)
    strokePolyline(ctx, sampleLine(e, minN, maxN, params, true, view))
  }

  const nStart = Math.floor(minN / SQUARE_M - 1) * SQUARE_M
  const nEnd   = Math.ceil (maxN / SQUARE_M + 1) * SQUARE_M
  const hLines = []
  for (let nrth = nStart; nrth <= nEnd; nrth += SQUARE_M) {
    hLines.push(nrth)
    strokePolyline(ctx, sampleLine(nrth, minE, maxE, params, false, view))
  }

  // ── 100km square IDs, one per visible cell, dropped at each cell's SW
  // corner (same convention printed paper MGRS charts use). The column
  // straddling SPLIT_LNG has its natural corner sitting in the clipped-away
  // sliver — labelEastingFloor floats its label onto the boundary so it's
  // visible. Identified by real easting relative to the boundary, not by
  // array index — vLines' leading entries shift with zoom/pan (more of the
  // other zone's territory gets projected into this frame at wider ranges),
  // so "index 0" doesn't reliably mean "the column at the boundary".
  const straddleE = labelEastingFloor
    ? Math.floor(labelEastingFloor((minN + maxN) / 2) / SQUARE_M) * SQUARE_M
    : null

  ctx.fillStyle = LABEL_COLOR
  ctx.font = '11px "Roboto Mono", monospace'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'bottom'
  for (const e of vLines) {
    for (const nrth of hLines) {
      const sq = mgrs100kSquareId(zone, e + SQUARE_M / 2, nrth + SQUARE_M / 2)
      const labelE = (straddleE != null && e === straddleE) ? Math.max(e, labelEastingFloor(nrth)) : e
      const { lat: cLat, lng: cLng } = tmInverse(labelE, nrth, params)
      const corner = latLngToCanvas(cLat, cLng, view)
      if (corner.x < -20 || corner.x > width + 20 || corner.y < -20 || corner.y > height + 20) continue
      ctx.fillText(sq, corner.x + 3, corner.y - 3)
    }
  }
}

// Syria-specific: real zone split at SPLIT_LNG, verified against real in-game
// MGRS on both sides (2026-07-07). Only Syria gets this treatment for now —
// see drawSingleZoneGrid for every other theatre.
function drawSyriaSplitGrid(ctx, view, hemisphere, fineSpacing) {
  const { width, height, centerLat, centerLng } = view

  let screenMinLat = Infinity, screenMaxLat = -Infinity
  for (const [x, y] of screenSamples(width, height)) {
    const { lat } = canvasToLatLng(x, y, view)
    screenMinLat = Math.min(screenMinLat, lat)
    screenMaxLat = Math.max(screenMaxLat, lat)
  }

  ctx.save()
  clipHalf(ctx, view, 'west', screenMinLat, screenMaxLat)
  drawZoneGrid(ctx, view, WEST_ZONE, hemisphere, fineSpacing)
  ctx.restore()

  // East zone's own easting of the SPLIT_LNG boundary, per row — used to
  // float the first (straddling) column's label onto the visible side.
  const eastParams = utmZoneParams(EAST_ZONE, hemisphere)
  const boundaryEastingAt = (northing) => {
    const approxLat = tmInverse(eastParams.false_easting, northing, eastParams).lat
    return tmForward(approxLat, SPLIT_LNG, eastParams).easting
  }

  ctx.save()
  clipHalf(ctx, view, 'east', screenMinLat, screenMaxLat)
  drawZoneGrid(ctx, view, EAST_ZONE, hemisphere, fineSpacing, boundaryEastingAt)
  ctx.restore()

  // ── True zone boundary meridian — unclipped, spans both halves ───────────
  drawBoundaryLine(ctx, view, screenMinLat, screenMaxLat)

  // ── Grid zone designator (zone + latitude band) for whichever side the
  // view is currently centered on ───────────────────────────────────────────
  const zone = centerLng < SPLIT_LNG ? WEST_ZONE : EAST_ZONE
  ctx.font = 'bold 12px "Roboto Mono", monospace'
  ctx.fillStyle = LABEL_COLOR
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText(`${zone}${latBand(centerLat)}`, 8, 8)
}

// Every other theatre: real UTM zone derived fresh each render from the
// view's own center (see the "Ben Gurion" note in commit history — fixing
// the zone to one meridian silently breaks anywhere far from it). Almost
// every DCS map actually spans 2-4 real UTM zones (only Nevada and the
// Marianas fit in one), so this is locally accurate wherever you're looking
// but will snap to a new zone if you pan across a real boundary — the
// Syria-style clipped split is the correct fix for that, just not yet built
// for these theatres (2026-07-07).
function drawSingleZoneGrid(ctx, view, hemisphere, fineSpacing) {
  const { centerLat, centerLng } = view
  const zone = utmZoneNumber(centerLng)
  drawZoneGrid(ctx, view, zone, hemisphere, fineSpacing)

  ctx.font = 'bold 12px "Roboto Mono", monospace'
  ctx.fillStyle = LABEL_COLOR
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText(`${zone}${latBand(centerLat)}`, 8, 8)
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object}  view    { centerLat, centerLng, pixelsPerNm, width, height, rangeNm, magvar, theatre }
 * @param {boolean} visible
 * @param {number}  brite   0-100
 */
export function drawMgrsGrid(ctx, view, visible, brite = 50) {
  if (!visible || brite <= 0) return
  const { centerLat, theatre, rangeNm } = view

  const hemisphere = centerLat < 0 ? 'S' : 'N'
  const fineSpacing = fineSpacingFor(rangeNm)
  const alpha = Math.max(0, Math.min(1, brite / 100))

  ctx.save()
  ctx.globalAlpha = alpha

  if (theatre === 'Syria') drawSyriaSplitGrid(ctx, view, hemisphere, fineSpacing)
  else                     drawSingleZoneGrid(ctx, view, hemisphere, fineSpacing)

  ctx.restore()
}
