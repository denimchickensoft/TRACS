/**
 * Declaration-based contact color and shared canvas symbology used across
 * AIC and ABM (own declaration stores, same DECLARATION enum from
 * createDeclarationStore.js — see abm-spec.md §1.2 for why the enum is
 * shared but the declarations themselves are kept independent).
 */

import { latLngToCanvas } from './projection.js'
import { DECLARATION } from './createDeclarationStore.js'

export const DECL_COLOR = {
  [DECLARATION.HOSTILE]:  '#FF4444',
  [DECLARATION.BOGEY]:  '#FFCC00',
  [DECLARATION.NEUTRAL]:  '#44CC44',
  [DECLARATION.FRIENDLY]: '#4488FF',
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

// Small squares in the contact's own color, fading with age. Shared by
// ABM's aircraft and missile rendering (AIC's PTL call site never passes a
// non-empty history/historyLimit, so this never runs there). symHalf
// defaults to ABM's SYM_HALF (3) so existing call sites are unaffected.
export function drawHistoryTrail(ctx, view, trail, historyLimit, color, symHalf = 3) {
  for (let i = 0; i < trail.length && i < historyLimit; i++) {
    const hp = latLngToCanvas(trail[i].lat, trail[i].lng, view)
    ctx.globalAlpha = Math.max(0.15, 0.6 - i * 0.12)
    ctx.fillStyle   = color
    ctx.fillRect(hp.x - symHalf / 2, hp.y - symHalf / 2, symHalf, symHalf)
  }
  ctx.globalAlpha = 1
}

// Missile tracking — small filled triangle pointing in the direction of
// travel (weapon.heading — DCS's raw engine-frame heading, validated
// reliable true-frame data per utils/bearing.js's header, unlike Olympus's
// own .track field), colored via the same DECL_COLOR declaration scheme as
// every other contact for consistency with the rest of the scope. In
// practice this almost always resolves to FRIENDLY: a non-friendly missile
// is only ever passed in here at all once independently AWACS/EWR-detected
// (server/src/missileDetection.js), own-coalition/neutral missiles are
// unconditionally visible — see abmScopeHelpers.js's getAbmVisibleMissiles.
//
// ptlSeconds/history/historyLimit default off so AIC's call site (which
// passes neither) keeps its current minimal treatment (triangle + PTL, no
// trail) without needing any changes there beyond ptlSeconds.
export function drawAbmMissiles(ctx, view, missiles, getDecl, ptlSeconds = 0, history = null, historyLimit = 0) {
  for (const [id, weapon] of Object.entries(missiles)) {
    if (!weapon.position) continue
    const decl = getDecl(id, weapon)
    const color = DECL_COLOR[decl] ?? DECL_COLOR[DECLARATION.BOGEY]
    const { x, y } = latLngToCanvas(weapon.position.lat, weapon.position.lng, view)

    drawHistoryTrail(ctx, view, (history ?? {})[id] || [], historyLimit, color)

    if (ptlSeconds > 0) drawPtl(ctx, x, y, { ...weapon, track: weapon.heading }, view, ptlSeconds, color)

    const headingRad = weapon.heading ?? 0
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(headingRad - (view.declinationDeg ?? 0) * Math.PI / 180)
    ctx.beginPath()
    ctx.moveTo(0, -4)
    ctx.lineTo(2.5, 3)
    ctx.lineTo(-2.5, 3)
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
    ctx.restore()
  }
}
