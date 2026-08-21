/**
 * ABM BRAA line / threat rings — ported from AIC (drawAicContacts.js's
 * drawBraaOverlays/drawThreatRings), same keypresses/commands, same
 * geometry. One deliberate difference (2026-07-07 direction): the BRAA
 * line prints its bearing/range along the line, the way drawRbl's RBL
 * label already does — AIC's BRAA line has no on-scope label (it relies on
 * the separate BraaList side panel, which ABM does not port).
 */

import { latLngToCanvas } from '../../../utils/projection.js'
import { gridBearingRangeNm, toMagneticFromTrue } from '../../../utils/bearing.js'

function computeBraa(fighter, bogey, declinationDeg, theatre) {
  const fp = fighter.position, bp = bogey.position
  if (!fp || !bp) return null

  const { gridBearingDeg, rangeNm } = gridBearingRangeNm(fp.lat, fp.lng, bp.lat, bp.lng, theatre)
  const magBrgDeg = toMagneticFromTrue(gridBearingDeg, declinationDeg)

  return { bearing: Math.round(magBrgDeg) || 360, range: Math.round(rangeNm) }
}

// units: merged air+ground/naval visible units (BRAA pairing works across both)
export function drawBraaOverlays(ctx, view, braaList, units, declinationDeg) {
  for (const pair of braaList) {
    const fighter = units[pair.fighterId]
    const bogey   = units[pair.bogeyId]
    if (!fighter?.position || !bogey?.position) continue

    const fp = latLngToCanvas(fighter.position.lat, fighter.position.lng, view)
    const bp = latLngToCanvas(bogey.position.lat,   bogey.position.lng,   view)

    ctx.strokeStyle = 'rgba(255,255,100,0.55)'
    ctx.lineWidth   = 0.75
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(fp.x, fp.y)
    ctx.lineTo(bp.x, bp.y)
    ctx.stroke()
    ctx.setLineDash([])

    const braa = computeBraa(fighter, bogey, declinationDeg, view.theatre)
    if (braa) {
      const label = `${String(braa.bearing).padStart(3, '0')}°M  ${braa.range}NM`
      const midX  = (fp.x + bp.x) / 2
      const midY  = (fp.y + bp.y) / 2
      ctx.font      = '11px "Roboto Mono", monospace'
      ctx.textAlign = 'center'
      ctx.fillStyle = 'rgba(0,0,0,0.4)'
      ctx.fillText(label, midX + 1, midY - 5)
      ctx.fillStyle = 'rgba(255,255,150,0.9)'
      ctx.fillText(label, midX, midY - 6)
    }
  }
}

// units: merged air+ground/naval visible units
// Ring color signals whether a BOGEY/HOSTILE contact is inside — green
// (clear) or purple (violated) — deliberately distinct from the acq/eng
// rings' declaration colors (drawAbmGroundContacts.js) so the two ring
// systems can't be confused at a glance (2026-07-07).
export function drawThreatRings(ctx, view, units, threatRings, threatRadius, getDecl) {
  if (!threatRings.size) return
  ctx.lineWidth = 0.75
  ctx.setLineDash([6, 4])
  for (const unitId of threatRings) {
    const unit = units[unitId]
    if (!unit?.position) continue

    const violated = Object.entries(units).some(([id, u]) => {
      if (id === unitId || !u.position) return false
      const decl = getDecl(id, u)
      if (decl !== 'BOGEY' && decl !== 'HOSTILE') return false
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
}
