import { latLngToCanvas } from './projection.js'
import { fixSymbolType, drawFixSymbol } from './fixSymbol.js'

const HOLD_COLOR_FALLBACK = '#00CED1'
const ARC_SEGS   = 16
const TRI_GAP    = 6  // px clearance between racetrack endpoint and fix triangle center

function projectPoint(lat, lon, hdgDeg, distNm) {
  const R    = 3440.065
  const lat1 = lat * Math.PI / 180
  const lon1 = lon * Math.PI / 180
  const d    = distNm / R
  const brg  = hdgDeg * Math.PI / 180
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg)
  )
  const lon2 = lon1 + Math.atan2(
    Math.sin(brg) * Math.sin(d) * Math.cos(lat1),
    Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
  )
  return { lat: lat2 * 180 / Math.PI, lon: lon2 * 180 / Math.PI }
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
// course = inbound course (magnetic); trueCourse = course + magvar.
// The fix (lat, lon) is where the inbound leg terminates.
// Arc centers are offset perpendicular to course by turnRadius.
function buildRacetrackPoly(lat, lon, trueCourse, turnDir, legNm, turnRadius) {
  const outboundHdg = (trueCourse + 180) % 360
  const perpRight   = (trueCourse + 90)  % 360
  const perpLeft    = (trueCourse - 90 + 360) % 360

  const cw          = turnDir !== 'L'
  const turnOff     = cw ? perpRight : perpLeft   // perpendicular toward turn centers
  const outboundOff = cw ? perpLeft  : perpRight  // opposite side for outbound-end center

  const R = turnRadius

  // Arc centers
  const c1 = projectPoint(lat, lon, turnOff, R)
  const p1 = projectPoint(lat, lon, turnOff, 2 * R)          // outbound leg start
  const p2 = projectPoint(p1.lat, p1.lon, outboundHdg, legNm) // outbound leg end
  const c2 = projectPoint(p2.lat, p2.lon, outboundOff, R)

  // Generate 180° arc points around center, starting at startAngle, CW or CCW
  function arc(center, startAngle) {
    const pts = []
    for (let i = 0; i <= ARC_SEGS; i++) {
      const a = cw
        ? (startAngle + i * 180 / ARC_SEGS + 360) % 360
        : (startAngle - i * 180 / ARC_SEGS + 720) % 360
      pts.push(projectPoint(center.lat, center.lon, a, R))
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
 * @param {object}   view      { centerLat, centerLng, pixelsPerNm, width, height, magvar }
 * @param {object[]} holdings  from holdings store
 * @param {boolean}  visible
 * @param {number}   brite     0–100
 * @param {number}   csMap     0–5
 */
export function drawHoldings(ctx, view, holdings, visible, brite = 50, csMap = 2, colors = null) {
  if (!visible || !holdings.length || brite <= 0) return

  const { width, height } = view
  const alpha    = Math.max(0, Math.min(1, brite / 100))
  const magvar   = view.magvar ?? 0
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
    const trueCourse = ((hold.course ?? 0) + magvar + 360) % 360

    const poly = buildRacetrackPoly(hold.lat, hold.lon, trueCourse, hold.turnDir ?? 'R', legNm, turnRadius)

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
      const dxL = fixPt.x - last.x, dyL = fixPt.y - last.y
      const lenL = Math.hypot(dxL, dyL)
      if (lenL > TRI_GAP) ctx.lineTo(last.x + dxL * TRI_GAP / lenL, last.y + dyL * TRI_GAP / lenL)
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
