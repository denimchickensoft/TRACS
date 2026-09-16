/**
 * AIC contact rendering:
 *   - HAFU symbols (HOSTILE/BOGEY/NEUTRAL/FRIENDLY)
 *   - Predicted Track Lines (PTL)
 *   - Dugout diamonds on the gold band for out-of-range hostiles
 *   - BRAA intercept overlay lines
 */

import { latLngToCanvas } from '../../../utils/projection.js'
import { gridBearingRangeNm, toMagneticFromTrue, destinationPoint } from '../../../utils/bearing.js'
import { DECLARATION } from '../../../store/aic.js'
import { computeAicIntercept } from '../aicGeometry.js'

export const DECL_COLOR = {
  [DECLARATION.HOSTILE]:  '#FF4444',
  [DECLARATION.BOGEY]:  '#FFCC00',
  [DECLARATION.NEUTRAL]:  '#44CC44',
  [DECLARATION.FRIENDLY]: '#4488FF',
}

// Pixel radius for symSize 1-5. Default (3) → 9px.
export function symRadius(symSize) { return 3 + (symSize - 1) * 2 }

export function drawSymbol(ctx, x, y, declaration, S, colorOverride = null) {
  const color = colorOverride ?? DECL_COLOR[declaration] ?? DECL_COLOR[DECLARATION.BOGEY]
  ctx.strokeStyle = color
  ctx.lineWidth   = 2

  switch (declaration) {
    case DECLARATION.HOSTILE: {
      // Two legs only — no base. Wide angle (~90°).
      const baseHW = S                                          // total width 2S — matches other symbols
      const height = S / Math.tan(50 * Math.PI / 180)          // derived from 100° apex: height = baseHW / tan(50°)
      const apexY  = y - height * 0.6
      const baseY  = y + height * 0.4
      ctx.beginPath()
      ctx.moveTo(x - baseHW, baseY)
      ctx.lineTo(x, apexY)
      ctx.lineTo(x + baseHW, baseY)
      ctx.stroke()
      break
    }
    case DECLARATION.FRIENDLY: {
      // Semi-circle dome up — clockwise from left (π) through top to right (0)
      ctx.beginPath()
      ctx.arc(x, y, S, Math.PI, 0, false)
      ctx.stroke()
      break
    }
    case DECLARATION.NEUTRAL: {
      ctx.strokeStyle = DECL_COLOR[DECLARATION.NEUTRAL]
      ctx.beginPath()
      ctx.arc(x, y, S, Math.PI, 0, false)
      ctx.stroke()
      break
    }
    case DECLARATION.BOGEY:
    default: {
      // Staple ⊓ — top bar + two legs pointing down
      ctx.beginPath()
      ctx.moveTo(x - S, y - S * 0.5)
      ctx.lineTo(x + S, y - S * 0.5)
      ctx.moveTo(x - S, y - S * 0.5)
      ctx.lineTo(x - S, y + S * 0.5)
      ctx.moveTo(x + S, y - S * 0.5)
      ctx.lineTo(x + S, y + S * 0.5)
      ctx.stroke()
      break
    }
  }
}

export function drawPtl(ctx, x, y, unit, view, ptlSeconds, color) {
  if (!unit.speed || !unit.track) return
  const distNm = (unit.speed * ptlSeconds) / 1852
  if (distNm < 0.01) return

  // Rotate track by declination so PTL aligns with the magnetic-north-up canvas.
  const magTrackRad = unit.track - view.declinationDeg * Math.PI / 180
  const endX = x + Math.sin(magTrackRad) * distNm * view.pixelsPerNm
  const endY = y - Math.cos(magTrackRad) * distNm * view.pixelsPerNm

  ctx.strokeStyle = color
  ctx.lineWidth   = 2
  ctx.setLineDash([])
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(endX, endY)
  ctx.stroke()
}

function drawDugout(ctx, view, units, getDecl, rangeNm, symSize) {
  const { pixelsPerNm, width, height } = view
  const cx    = width  / 2
  const cy    = height / 2
  const innerR = Math.max(0, (rangeNm - 10) * pixelsPerNm)
  const D      = Math.max(4, 3 + symSize * 1.2)  // diamond half-size

  ctx.lineWidth = 1.5

  for (const [id, unit] of Object.entries(units)) {
    if (!unit.position) continue
    const decl = getDecl(id, unit)
    if (decl !== DECLARATION.HOSTILE && decl !== DECLARATION.BOGEY) continue

    const { x, y } = latLngToCanvas(unit.position.lat, unit.position.lng, view)
    const dx = x - cx, dy = y - cy
    if (Math.hypot(dx, dy) <= innerR) continue  // within inner ring — on scope, not dugout

    // Place diamond on the inner ring at the bearing toward this contact
    const angle = Math.atan2(dx, -dy)
    const bx    = cx + Math.sin(angle) * innerR
    const by    = cy - Math.cos(angle) * innerR

    ctx.strokeStyle = DECL_COLOR[decl]
    ctx.beginPath()
    ctx.moveTo(bx,     by - D)
    ctx.lineTo(bx + D, by)
    ctx.lineTo(bx,     by + D)
    ctx.lineTo(bx - D, by)
    ctx.closePath()
    ctx.stroke()
  }
}

function computeMergePt(fighter, bogey) {
  const result = computeAicIntercept(fighter, bogey)
  if (!result) return null
  return { lat: result.mergeLat, lng: result.mergeLng }
}

function drawBraaOverlays(ctx, view, braaList, units, rangeNm) {
  const cx    = view.width  / 2
  const cy    = view.height / 2
  const clipR = Math.max(0, (rangeNm - 10) * view.pixelsPerNm)

  for (const pair of braaList) {
    const fighter = units[pair.fighterId]
    const bogey   = units[pair.bogeyId]
    if (!fighter?.position || !bogey?.position) continue

    const fp = latLngToCanvas(fighter.position.lat, fighter.position.lng, view)
    const bp = latLngToCanvas(bogey.position.lat,   bogey.position.lng,   view)

    // Dashed line between fighter and bogey
    ctx.strokeStyle = 'rgba(255,255,100,0.55)'
    ctx.lineWidth   = 0.75
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(fp.x, fp.y)
    ctx.lineTo(bp.x, bp.y)
    ctx.stroke()
    ctx.setLineDash([])

    // Merge point dot — only within the inner dugout ring
    const merge = computeMergePt(fighter, bogey)
    if (merge) {
      const mp = latLngToCanvas(merge.lat, merge.lng, view)
      if (Math.hypot(mp.x - cx, mp.y - cy) <= clipR) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)'
        ctx.beginPath()
        ctx.arc(mp.x, mp.y, 3, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
}

function drawRbl(ctx, view, rbl, declinationDeg) {
  if (!rbl?.anchor || !rbl?.end) return

  const ap = latLngToCanvas(rbl.anchor.lat, rbl.anchor.lng, view)
  const ep = latLngToCanvas(rbl.end.lat,    rbl.end.lng,    view)

  ctx.strokeStyle = rbl.fixed ? 'rgba(167,167,167,0.85)' : 'rgba(167,167,167,0.5)'
  ctx.lineWidth   = 1
  ctx.setLineDash(rbl.fixed ? [] : [5, 5])
  ctx.beginPath()
  ctx.moveTo(ap.x, ap.y)
  ctx.lineTo(ep.x, ep.y)
  ctx.stroke()
  ctx.setLineDash([])

  // Endpoint dots
  ctx.fillStyle = 'rgba(167,167,167,0.9)'
  ctx.beginPath(); ctx.arc(ap.x, ap.y, 3, 0, Math.PI * 2); ctx.fill()
  ctx.beginPath(); ctx.arc(ep.x, ep.y, 3, 0, Math.PI * 2); ctx.fill()

  // Bearing / range label at midpoint
  const { gridBearingDeg, rangeNm } = gridBearingRangeNm(rbl.anchor.lat, rbl.anchor.lng, rbl.end.lat, rbl.end.lng, view.theatre)
  const range = Math.round(rangeNm)
  const magBrg = Math.round(toMagneticFromTrue(gridBearingDeg, declinationDeg)) || 360
  const label       = `${String(magBrg).padStart(3, '0')}°M  ${range}NM`

  const midX = (ap.x + ep.x) / 2
  const midY = (ap.y + ep.y) / 2

  ctx.font      = '11px "Roboto Mono", monospace'
  ctx.textAlign = 'center'
  ctx.fillStyle = 'rgba(0,0,0,0.4)'
  ctx.fillText(label, midX + 1, midY - 5)
  ctx.fillStyle = 'rgba(167,167,167,0.9)'
  ctx.fillText(label, midX, midY - 6)
}

// Ring color signals whether a BOGEY/HOSTILE contact is inside — green
// (clear) or purple (violated), matching ABM's threat rings
// (drawAbmBraa.js) so both scopes read the same way (2026-07-07).
// Clipped to the inner (on-scope) circle so a ring near the edge of range
// doesn't bleed into the gold dugout band (2026-08-01).
function drawThreatRings(ctx, view, units, threatRings, threatRadius, getDecl, clipR, cx, cy) {
  if (!threatRings.size) return
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, clipR, 0, Math.PI * 2)
  ctx.clip()

  ctx.lineWidth   = 0.75
  ctx.setLineDash([6, 4])
  for (const unitId of threatRings) {
    const unit = units[unitId]
    if (!unit?.position) continue

    const violated = Object.entries(units).some(([id, u]) => {
      if (id === unitId || !u.position) return false
      const decl = getDecl(id, u)
      if (decl !== DECLARATION.BOGEY && decl !== DECLARATION.HOSTILE) return false
      const nmPerDegLng = 60 * Math.cos(unit.position.lat * Math.PI / 180)
      const dN = (u.position.lat - unit.position.lat) * 60
      const dE = (u.position.lng - unit.position.lng) * nmPerDegLng
      return Math.hypot(dN, dE) <= threatRadius
    })

    ctx.strokeStyle = violated ? 'rgba(170,68,255,0.75)' : 'rgba(68,204,68,0.6)'
    const { x, y } = latLngToCanvas(unit.position.lat, unit.position.lng, view)
    ctx.beginPath()
    ctx.arc(x, y, threatRadius * view.pixelsPerNm, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.setLineDash([])
  ctx.restore()
}

function drawFadedContacts(ctx, view, fadedContacts, now, clipR, cx, cy, symSize, ptlSeconds) {
  const S = symRadius(symSize)
  ctx.save()
  ctx.globalAlpha = 0.5

  for (const [, entry] of Object.entries(fadedContacts)) {
    const { unit, disappearedAt, decl } = entry
    if (!unit.position) continue
    const elapsed     = (now - disappearedAt) / 1000
    const distNm      = (unit.speed ?? 0) * elapsed / 1852
    const track       = unit.track ?? 0
    const { lat: coastLat, lng: coastLng } = destinationPoint(unit.position.lat, unit.position.lng, track * 180 / Math.PI, distNm)
    const { x, y }   = latLngToCanvas(coastLat, coastLng, view)
    if (Math.hypot(x - cx, y - cy) > clipR) continue

    // PTL along coast track (gray)
    drawPtl(ctx, x, y, unit, view, ptlSeconds, '#888')

    // Same HAFU symbol, gray
    drawSymbol(ctx, x, y, decl ?? DECLARATION.BOGEY, S, '#888')
  }

  ctx.restore()
}

export function drawAicContacts(
  ctx, view, units, getDecl, ptlSeconds, symSize, braaList, rangeNm,
  rbl = null, declinationDeg = 0,
  threatRings = new Set(), threatRadius = 35,
  fadedContacts = {}, fadedNow = 0,
  findMarker = null,
  centroidMarker = null,
  axisLine = null,
) {
  const { width, height } = view
  const S = symRadius(symSize)

  ctx.clearRect(0, 0, width, height)
  ctx.save()

  const cx      = width  / 2
  const cy      = height / 2
  const clipR   = Math.max(0, (rangeNm - 10) * view.pixelsPerNm)

  // Threat rings (under everything else)
  drawThreatRings(ctx, view, units, threatRings, threatRadius, getDecl, clipR, cx, cy)

  // BRAA overlays first (under symbols)
  drawBraaOverlays(ctx, view, braaList, units, rangeNm)

  // Dugout diamonds on the band
  drawDugout(ctx, view, units, getDecl, rangeNm, symSize)

  // Contacts: PTL then symbol — only within the inner dugout ring

  for (const [id, unit] of Object.entries(units)) {
    if (!unit.position) continue
    const { x, y } = latLngToCanvas(unit.position.lat, unit.position.lng, view)
    if (Math.hypot(x - cx, y - cy) > clipR) continue  // beyond inner ring — dugout only

    const decl  = getDecl(id, unit)
    const color = DECL_COLOR[decl] ?? DECL_COLOR[DECLARATION.BOGEY]

    drawPtl(ctx, x, y, unit, view, ptlSeconds, color)
    drawSymbol(ctx, x, y, decl, S)
  }

  // Faded / coasting contacts
  drawFadedContacts(ctx, view, fadedContacts, fadedNow, clipR, cx, cy, symSize, ptlSeconds)

  // RBL on top of everything
  drawRbl(ctx, view, rbl, declinationDeg)

  // .find marker — small green square, clipped to inner dugout circle
  if (findMarker) {
    const { x, y } = latLngToCanvas(findMarker.lat, findMarker.lon, view)
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, clipR, 0, Math.PI * 2)
    ctx.clip()
    ctx.fillStyle = '#00e000'
    ctx.fillRect(Math.round(x) - 4, Math.round(y) - 4, 8, 8)
    ctx.restore()
  }

  // .centroid debug marker — magenta X at the hostile-picture centroid used
  // to derive the threat axis (see computePicture.js).
  if (centroidMarker) {
    const { x, y } = latLngToCanvas(centroidMarker.lat, centroidMarker.lng, view)
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, clipR, 0, Math.PI * 2)
    ctx.clip()
    ctx.strokeStyle = '#ff00ff'
    ctx.lineWidth = 2
    const r = 6
    ctx.beginPath()
    ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r)
    ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r)
    ctx.stroke()
    ctx.restore()
  }

  // .axis debug line — cyan line through the dynamic threat axis (see
  // _deriveThreatAxis in computePicture.js), origin marked with a dot.
  // axisLine.axisBearing is TRUE; convert to magnetic for canvas (magnetic-
  // north-up display), same as drawSector in drawAicLayers.js.
  if (axisLine?.origin) {
    const { x: ox, y: oy } = latLngToCanvas(axisLine.origin.lat, axisLine.origin.lng, view)
    const mag = (axisLine.axisBearing - declinationDeg + 360) % 360
    const sin = Math.sin(mag * Math.PI / 180), cos = Math.cos(mag * Math.PI / 180)
    const len = Math.max(width, height)

    ctx.save()
    ctx.strokeStyle = 'rgba(0,220,255,0.7)'
    ctx.lineWidth = 1.5
    ctx.setLineDash([5, 5])
    ctx.beginPath()
    ctx.moveTo(ox - sin * len, oy + cos * len)
    ctx.lineTo(ox + sin * len, oy - cos * len)
    ctx.stroke()
    ctx.setLineDash([])

    ctx.fillStyle = 'rgba(0,220,255,0.9)'
    ctx.beginPath(); ctx.arc(ox, oy, 3, 0, Math.PI * 2); ctx.fill()
    ctx.restore()
  }

  ctx.restore()
}
