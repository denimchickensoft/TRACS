import { latLngToCanvas } from '../utils/projection.js'
import { fixSymbolType, drawFixSymbol } from './fixSymbol.js'
import { gridDestinationPoint } from '../utils/bearing.js'

const HOLD_COLOR_FALLBACK = '#00CED1'
const ARC_SEGS   = 16
const TRI_GAP    = 6  // px clearance between racetrack endpoint and fix triangle center

// hdgDeg here is grid-frame (course + declinationDeg — see buildRacetrackPoly
// below), so this delegates to gridDestinationPoint rather than a real-
// geodesic projector; a grid bearing fed into real-geodesic math would skew
// the racetrack by the local grid convergence. Field renamed lng->lon on the
// way out to match this file's existing convention.
function projectPoint(lat, lon, hdgDeg, distNm, theatre) {
  const { lat: lat2, lng: lon2 } = gridDestinationPoint(lat, lon, hdgDeg, distNm, theatre)
  return { lat: lat2, lon: lon2 }
}

function icaoSpeed(minAlt) {
  if (minAlt == null || minAlt <= 6000)  return 200
  if (minAlt <= 14000)                   return 230
  if (minAlt <= 20000)                   return 240
  return 265
}

function icaoLegTime(minAlt) {
  return (minAlt != null && minAlt > 14000) ? 1.5 : 1.0
}

// Build racetrack polygon.
// course = inbound course (magnetic); gridCourse = course + declinationDeg,
// i.e. grid frame (DCS's own "true" — see utils/bearing.js), not real
// geographic true. projectPoint (-> gridDestinationPoint) expects exactly
// that frame, so this is a matched pair.
// The fix (lat, lon) is where the inbound leg terminates.
// Arc centers are offset perpendicular to course by turnRadius.
function buildRacetrackPoly(lat, lon, gridCourse, turnDir, legNm, turnRadius, theatre) {
  const outboundHdg = (gridCourse + 180) % 360
  const perpRight   = (gridCourse + 90)  % 360
  const perpLeft    = (gridCourse - 90 + 360) % 360

  const cw          = turnDir !== 'L'
  const turnOff     = cw ? perpRight : perpLeft   // perpendicular toward turn centers
  const outboundOff = cw ? perpLeft  : perpRight  // opposite side for outbound-end center

  const R = turnRadius

  // Arc centers
  const c1 = projectPoint(lat, lon, turnOff, R, theatre)
  const p1 = projectPoint(lat, lon, turnOff, 2 * R, theatre)          // outbound leg start
  const p2 = projectPoint(p1.lat, p1.lon, outboundHdg, legNm, theatre) // outbound leg end
  const c2 = projectPoint(p2.lat, p2.lon, outboundOff, R, theatre)

  // Generate 180° arc points around center, starting at startAngle, CW or CCW
  function arc(center, startAngle) {
    const pts = []
    for (let i = 0; i <= ARC_SEGS; i++) {
      const a = cw
        ? (startAngle + i * 180 / ARC_SEGS + 360) % 360
        : (startAngle - i * 180 / ARC_SEGS + 720) % 360
      pts.push(projectPoint(center.lat, center.lon, a, R, theatre))
    }
    return pts
  }

  // Bearing from each arc center to its entry point
  const fixAngleFromC1 = (turnOff    + 180) % 360  // c1→fix
  const p2AngleFromC2  = (outboundOff + 180) % 360 // c2→p2

  // Fix-end arc (fix → p1), outbound leg (p1 → p2), outbound-end arc (p2 → p3).
  // closePath() closes the inbound leg (p3 → fix).
  return [
    ...arc(c1, fixAngleFromC1),
    p2,
    ...arc(c2, p2AngleFromC2),
  ]
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object}   view      { centerLat, centerLng, pixelsPerNm, width, height, declinationDeg }
 * @param {object[]} holdings  from holdings store
 * @param {boolean}  visible
 * @param {number}   brite     0–100
 * @param {number}   csMap     0–5
 */
export function drawHoldings(ctx, view, holdings, visible, brite = 50, csMap = 2, colors = null) {
  if (!visible || !holdings.length || brite <= 0) return

  const { width, height } = view
  const alpha    = Math.max(0, Math.min(1, brite / 100))
  const declinationDeg = view.declinationDeg ?? 0
  const fontSize = 6 + csMap * 2

  const holdsEntry = colors?.HOLDS
  ctx.save()
  const color = holdsEntry?.stroke ?? HOLD_COLOR_FALLBACK
  ctx.globalAlpha = alpha
  ctx.strokeStyle = color
  ctx.fillStyle   = color
  ctx.setLineDash((holdsEntry?.dash ?? []).map(v => v * view.pixelsPerNm))
  ctx.lineWidth   = 1.0

  for (const hold of holdings) {
    const fixPt = latLngToCanvas(hold.lat, hold.lon, view)
    if (
      fixPt.x < -300 || fixPt.x > width + 300 ||
      fixPt.y < -300 || fixPt.y > height + 300
    ) continue

    const speed      = hold.speedLimit ?? icaoSpeed(hold.minAlt)
    const legTime    = hold.legTime    ?? icaoLegTime(hold.minAlt)
    const legNm      = hold.legLength  ?? (legTime * speed / 60)
    const turnRadius = speed / (60 * Math.PI)
    const gridCourse = ((hold.course ?? 0) + declinationDeg + 360) % 360

    const poly = buildRacetrackPoly(hold.lat, hold.lon, gridCourse, hold.turnDir ?? 'R', legNm, turnRadius, view.theatre)

    // poly[0] is the fix point; the outbound arc starts there and closePath() would
    // draw the inbound leg back to it. Leave a gap around the fix triangle instead.
    if (poly.length >= 2) {
      const cpts = poly.map(({ lat, lon }) => latLngToCanvas(lat, lon, view))
      // cpts[0] === fixPt; start the path slightly past fix toward cpts[1]
      const p1  = cpts[1]
      const dx0 = p1.x - fixPt.x, dy0 = p1.y - fixPt.y
      const len0 = Math.hypot(dx0, dy0)
      const startX = len0 > TRI_GAP ? fixPt.x + dx0 * TRI_GAP / len0 : p1.x
      const startY = len0 > TRI_GAP ? fixPt.y + dy0 * TRI_GAP / len0 : p1.y

      ctx.beginPath()
      ctx.moveTo(startX, startY)
      for (let i = 1; i < cpts.length; i++) ctx.lineTo(cpts[i].x, cpts[i].y)

      // Close the inbound leg to just before the fix triangle
      const last = cpts[cpts.length - 1]
      const dxL = last.x - fixPt.x, dyL = last.y - fixPt.y
      const lenL = Math.hypot(dxL, dyL)
      if (lenL > TRI_GAP) ctx.lineTo(fixPt.x + dxL * TRI_GAP / lenL, fixPt.y + dyL * TRI_GAP / lenL)
      ctx.stroke()
    }

    drawFixSymbol(ctx, fixPt.x, fixPt.y, fixSymbolType(hold.ident))

    // Ident label
    if (csMap > 0) {
      ctx.font         = `${fontSize}px "Roboto Mono", monospace`
      ctx.textAlign    = 'left'
      ctx.textBaseline = 'bottom'
      ctx.fillText(hold.ident, fixPt.x + 4, fixPt.y - 4)
    }
  }

  ctx.restore()
}
