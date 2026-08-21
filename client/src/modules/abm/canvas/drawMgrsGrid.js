import { latLngToCanvas, canvasToLatLng } from '../../../utils/projection.js'
import { tmForward, tmInverse } from '../../../utils/transverseMercator.js'
import { utmZoneNumber, utmZoneParams, mgrs100kSquareId, latBand } from '../../../utils/mgrs.js'

const SQUARE_M = 100000
const GRID_COLOR     = '#33CC33'
const FINE_COLOR     = '#227722'
const LABEL_COLOR    = '#55EE55'
const BOUNDARY_COLOR = '#FFCC00'

// Real UTM-zone grid lines are only exactly straight in that zone's own TM
// frame; once reprojected through DCS's theatre TM + declination rotation
// (projection.js) they bow slightly, so each drawn line is sampled and
// rendered as a polyline rather than a single straight segment.
const CURVE_STEPS = 12

// How finely meridians (zone-boundary seams) are sampled for clip paths and
// boundary lines, and how far past the screen's visible longitude range an
// unbounded band edge is padded so it fully contains the rotated (declination)
// screen rectangle.
const MERIDIAN_STEPS = 20
const LAT_PAD = 5
const LNG_MARGIN = 20

function fineSpacingFor(rangeNm) {
  if (rangeNm <= 20)  return 1000
  if (rangeNm <= 100) return 10000
  return 0 // no sub-grid at wide ranges — the 100km lines are enough
}

// Corners + edge midpoints, so a rotated (declination) view is still bounded
// correctly.
function screenSamples(width, height) {
  return [
    [0, 0], [width / 2, 0], [width, 0],
    [0, height / 2], [width, height / 2],
    [0, height], [width / 2, height], [width, height],
  ]
}

// Visible lat/lng range of the current screen, from the same corner +
// edge-midpoint samples. Used to find which real UTM zone boundaries are
// on screen right now, so zone splitting is derived per-render rather than
// pinned to any particular theatre.
function screenLatLngRange(view) {
  const { width, height } = view
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity
  for (const [x, y] of screenSamples(width, height)) {
    const { lat, lng } = canvasToLatLng(x, y, view)
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat)
    minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng)
  }
  return { minLat, maxLat, minLng, maxLng }
}

// Real UTM zone boundaries (every 6° of longitude) strictly inside
// [minLng, maxLng], ascending. A theatre's DCS grid can straddle any number
// of these — most DCS maps actually span 2-4 real UTM zones (only Nevada
// and the Marianas fit in one) — so however many fall on screen right now
// is how many seams get split.
function zoneBoundariesIn(minLng, maxLng) {
  const bounds = []
  const start = Math.ceil(minLng / 6) * 6
  for (let b = start; b < maxLng; b += 6) {
    if (b > minLng) bounds.push(b)
  }
  return bounds
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

// Clips the canvas to the screen band between loLng and hiLng (real
// longitude). Either bound may be null for "unbounded in that direction" —
// used for the outermost band on either edge of the visible screen, closed
// off well past the screen's visible longitude range so it fully covers
// that side regardless of zoom/pan/rotation. A bounded edge is the true
// zone-boundary meridian, which isn't straight on screen (DCS TM +
// declination rotation), so it's traced as a polyline.
function clipBand(ctx, view, loLng, hiLng, minLat, maxLat) {
  const lo = minLat - LAT_PAD
  const hi = maxLat + LAT_PAD
  const westFar = (loLng ?? hiLng) - LNG_MARGIN
  const eastFar = (hiLng ?? loLng) + LNG_MARGIN

  const meridianPts = (lng, fromLat, toLat) => {
    const pts = []
    for (let i = 0; i <= MERIDIAN_STEPS; i++) {
      const lat = fromLat + (toLat - fromLat) * i / MERIDIAN_STEPS
      pts.push(latLngToCanvas(lat, lng, view))
    }
    return pts
  }

  const westPts = loLng != null
    ? meridianPts(loLng, lo, hi)
    : [latLngToCanvas(lo, westFar, view), latLngToCanvas(hi, westFar, view)]
  const eastPts = hiLng != null
    ? meridianPts(hiLng, hi, lo)
    : [latLngToCanvas(hi, eastFar, view), latLngToCanvas(lo, eastFar, view)]

  ctx.beginPath()
  ;[...westPts, ...eastPts].forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y))
  ctx.closePath()
  ctx.clip()
}

// Draws a true zone-boundary meridian itself, unclipped, so it's visible
// across both neighboring bands' territory rather than stopping at either
// one's clip.
function drawBoundaryLine(ctx, view, lng, minLat, maxLat) {
  const lo = minLat - LAT_PAD
  const hi = maxLat + LAT_PAD
  ctx.save()
  ctx.strokeStyle = BOUNDARY_COLOR
  ctx.lineWidth = 1.5
  ctx.setLineDash([])
  const pts = []
  for (let i = 0; i <= MERIDIAN_STEPS; i++) {
    const lat = lo + (hi - lo) * i / MERIDIAN_STEPS
    pts.push(latLngToCanvas(lat, lng, view))
  }
  strokePolyline(ctx, pts)
  ctx.restore()
}

// For the band whose real UTM zone sits east of `seamLng`: given a northing
// (in that zone's own frame), returns the real easting of the seam meridian
// at that row. Used to float that band's westmost (straddling) 100km
// square's label off of its natural southwest corner — which sits on the
// wrong, clipped-away side of the seam — onto the seam itself.
//
// Only the east-of-a-seam band ever needs this. Labels are anchored at each
// cell's southwest corner; a band's clip only removes territory on one side
// of each of its seams, and the southwest corner of any cell in the band
// west of a seam is, by construction, further from that seam, not closer —
// so it's always safely on the visible side already. It's only the band
// east of a seam whose straddling column has its southwest corner sitting
// past the seam, in the clipped-out sliver.
function boundaryEastingAt(zone, hemisphere, seamLng) {
  const params = utmZoneParams(zone, hemisphere)
  return (northing) => {
    const approxLat = tmInverse(params.false_easting, northing, params).lat
    return tmForward(approxLat, seamLng, params).easting
  }
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
  // straddling this band's west seam has its natural corner sitting in the
  // clipped-away sliver — labelEastingFloor floats its label onto the
  // boundary so it's visible. Identified by real easting relative to the
  // boundary, not by array index — vLines' leading entries shift with
  // zoom/pan (more of the neighboring zone's territory gets projected into
  // this frame at wider ranges), so "index 0" doesn't reliably mean "the
  // column at the boundary".
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

// Splits the visible screen into however many real UTM zones it currently
// spans — zero seams (the common case: most DCS maps are viewed zoomed in
// enough, or are narrow enough, to sit in one real zone at a time) falls
// straight through to a single unclipped band, same as before this was
// generalized. Each seam found gets its own true zone-boundary meridian
// drawn across it, and each band is clipped and rendered in its own real
// UTM zone's frame. Re-derived every render from the current view, so
// panning across a real boundary produces the correct seam rather than the
// whole grid snapping between two single-zone approximations.
function drawMultiZoneGrid(ctx, view, hemisphere, fineSpacing) {
  const { centerLat, centerLng } = view
  const { minLat, maxLat, minLng, maxLng } = screenLatLngRange(view)
  const seams = zoneBoundariesIn(minLng, maxLng)
  const edges = [null, ...seams, null]

  for (let i = 0; i < edges.length - 1; i++) {
    const loLng = edges[i]
    const hiLng = edges[i + 1]
    const midLng = ((loLng ?? minLng) + (hiLng ?? maxLng)) / 2
    const zone = utmZoneNumber(midLng)
    const labelEastingFloor = loLng != null ? boundaryEastingAt(zone, hemisphere, loLng) : undefined

    ctx.save()
    if (loLng != null || hiLng != null) clipBand(ctx, view, loLng, hiLng, minLat, maxLat)
    drawZoneGrid(ctx, view, zone, hemisphere, fineSpacing, labelEastingFloor)
    ctx.restore()
  }

  for (const seam of seams) drawBoundaryLine(ctx, view, seam, minLat, maxLat)

  // ── Grid zone designator (zone + latitude band) for wherever the view is
  // currently centered ───────────────────────────────────────────────────
  const centerZone = utmZoneNumber(centerLng)
  ctx.font = 'bold 12px "Roboto Mono", monospace'
  ctx.fillStyle = LABEL_COLOR
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText(`${centerZone}${latBand(centerLat)}`, 8, 8)
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object}  view    { centerLat, centerLng, pixelsPerNm, width, height, rangeNm, declinationDeg }
 * @param {boolean} visible
 * @param {number}  brite   0-100
 */
export function drawMgrsGrid(ctx, view, visible, brite = 50) {
  if (!visible || brite <= 0) return
  const { centerLat, rangeNm } = view

  const hemisphere = centerLat < 0 ? 'S' : 'N'
  const fineSpacing = fineSpacingFor(rangeNm)
  const alpha = Math.max(0, Math.min(1, brite / 100))

  ctx.save()
  ctx.globalAlpha = alpha
  drawMultiZoneGrid(ctx, view, hemisphere, fineSpacing)
  ctx.restore()
}
