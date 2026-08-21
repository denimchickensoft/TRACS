/**
 * AIC static scope layers:
 *   - Range rings
 *   - Gold dugout band at outermost range
 *   - Threat sector wedge (two radials + arc)
 */

import { latLngToCanvas } from '../../../utils/projection.js'

export function drawAicLayers(ctx, view, rangeNm, ringSpacingNm, bullseyeLat, bullseyeLng, sector = null) {
  const { pixelsPerNm, width, height } = view
  const cx = width  / 2
  const cy = height / 2

  ctx.clearRect(0, 0, width, height)

  // ── Range rings ───────────────────────────────────────────────────────────────
  if (ringSpacingNm > 0) {
    ctx.strokeStyle = 'rgba(80,80,80,0.7)'
    ctx.lineWidth   = 0.5
    ctx.setLineDash([])

    const maxRingNm = rangeNm - 10

    for (let r = ringSpacingNm; r <= maxRingNm + ringSpacingNm * 0.01; r += ringSpacingNm) {
      ctx.beginPath()
      ctx.arc(cx, cy, r * pixelsPerNm, 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  // ── Gold dugout band ──────────────────────────────────────────────────────────
  const outerR = rangeNm * pixelsPerNm
  const innerR = Math.max(0, (rangeNm - 10) * pixelsPerNm)

  ctx.fillStyle = '#54492A'
  ctx.beginPath()
  ctx.arc(cx, cy, outerR, 0, Math.PI * 2, false)
  ctx.arc(cx, cy, innerR, 0, Math.PI * 2, true)
  ctx.fill()

  ctx.strokeStyle = 'rgba(255,255,255,1)'
  ctx.lineWidth   = 1
  ctx.setLineDash([6, 6])
  ctx.beginPath(); ctx.arc(cx, cy, outerR, 0, Math.PI * 2); ctx.stroke()
  ctx.beginPath(); ctx.arc(cx, cy, innerR, 0, Math.PI * 2); ctx.stroke()
  ctx.setLineDash([])

  // ── Placed sector ─────────────────────────────────────────────────────────────
  if (sector) drawSector(ctx, view, sector, false)
}

/**
 * Draw a sector wedge (two radials + arc).
 * sector.fromBearing and .toBearing are TRUE bearings (lat/lng-derived);
 * view.declinationDeg converts to canvas angles (magnetic-north-up display).
 * isPreview: dashed / lower opacity while user is still placing.
 */
export function drawSector(ctx, view, sector, isPreview = false) {
  if (!sector?.origin) return

  const { origin, fromBearing, toBearing, rangeNm } = sector
  const { x: ox, y: oy } = latLngToCanvas(origin.lat, origin.lng, view)
  const r = rangeNm * view.pixelsPerNm

  // Convert TRUE bearings to MAGNETIC for canvas (magnetic-north-up)
  const fromMag = (fromBearing - view.declinationDeg + 360) % 360
  const toMag   = (toBearing   - view.declinationDeg + 360) % 360

  // Canvas arc angles: magnetic bearing 0° (north) = canvas -π/2
  const startAngle = fromMag * Math.PI / 180 - Math.PI / 2
  const endAngle   = toMag   * Math.PI / 180 - Math.PI / 2

  const alpha = isPreview ? 0.22 : 0.35
  ctx.strokeStyle = `rgba(255,180,0,${alpha})`
  ctx.lineWidth   = isPreview ? 1 : 1.5
  ctx.setLineDash(isPreview ? [6, 4] : [])

  // Sector fill
  ctx.fillStyle = `rgba(255,180,0,${isPreview ? 0.015 : 0.025})`
  ctx.beginPath()
  ctx.moveTo(ox, oy)
  ctx.arc(ox, oy, r, startAngle, endAngle, false)   // false = clockwise
  ctx.closePath()
  ctx.fill()

  // Radial lines (using magnetic bearing for canvas direction)
  const sin1 = Math.sin(fromMag * Math.PI / 180), cos1 = Math.cos(fromMag * Math.PI / 180)
  const sin2 = Math.sin(toMag   * Math.PI / 180), cos2 = Math.cos(toMag   * Math.PI / 180)
  ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox + sin1 * r, oy - cos1 * r); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox + sin2 * r, oy - cos2 * r); ctx.stroke()

  // Arc
  ctx.beginPath(); ctx.arc(ox, oy, r, startAngle, endAngle, false); ctx.stroke()
  ctx.setLineDash([])

  // Origin dot
  ctx.fillStyle = `rgba(255,180,0,${alpha})`
  ctx.beginPath(); ctx.arc(ox, oy, 3, 0, Math.PI * 2); ctx.fill()
}
