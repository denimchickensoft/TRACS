/**
 * ABM ground/naval contact rendering — solid-filled circles, half the
 * pixel size of ABM's air symbol (SYM_HALF=3 in drawAbmContacts.js), using
 * the same declaration colors/store as air contacts. No datablock,
 * leader line, PTL, or history trail — declare-and-display only, like air,
 * but deliberately unadorned. Units with a known
 * acquisition/engagement range (client/public/units/groundunitdatabase.json,
 * navyunitdatabase.json, keyed by the Olympus unit.name type identifier)
 * get concentric range rings: dashed for acquisition, solid for engagement.
 * Either ring type can be hidden per-declaration (.acq/.eng commands in
 * AbmScope.jsx) via acqHidden/engHidden — Sets of DECLARATION values whose
 * rings should be suppressed.
 */

import { latLngToCanvas } from '../../../utils/projection.js'
import { DECL_COLOR } from '../../../utils/declarationSymbols.js'
import { DECLARATION } from '../../../store/abm.js'
import { HIGHLIGHT_TEAL, HIGHLIGHT_PURPLE } from '../../../utils/scopeConstants.js'

const GROUND_RADIUS = 1.5
const CULL_MARGIN   = 60
const METERS_PER_NM = 1852

function drawRangeRing(ctx, x, y, rangeM, pixelsPerNm, color, dashed) {
  const radiusPx = (rangeM / METERS_PER_NM) * pixelsPerNm
  if (radiusPx <= 0) return
  ctx.save()
  ctx.globalAlpha = 0.6
  ctx.strokeStyle = color
  ctx.lineWidth   = 1
  if (dashed) ctx.setLineDash([4, 4])
  ctx.beginPath()
  ctx.arc(x, y, radiusPx, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

// unitDb: plain object keyed by unit type name -> { acquisitionRange, engagementRange } (meters)
// acqHidden/engHidden: Sets of DECLARATION values whose rings are suppressed (.acq/.eng commands)
export function drawAbmGroundContacts(ctx, view, units, getDecl, unitDb, acqHidden = new Set(), engHidden = new Set(), highlightedIds = new Set()) {
  const { width, height, pixelsPerNm } = view

  for (const [id, unit] of Object.entries(units)) {
    if (!unit.position) continue
    const { x, y } = latLngToCanvas(unit.position.lat, unit.position.lng, view)
    if (x < -CULL_MARGIN || x > width + CULL_MARGIN || y < -CULL_MARGIN || y > height + CULL_MARGIN) continue

    const decl  = getDecl(id, unit)
    const color = DECL_COLOR[decl] ?? DECL_COLOR[DECLARATION.BOGEY]
    // Middle-click highlight override — symbol only (ground/naval contacts
    // have no datablock — see module header). Non-friendly (HOSTILE/BOGEY)
    // highlights purple instead of teal, matching drawAbmContacts.js.
    const highlightColor = (decl === DECLARATION.HOSTILE || decl === DECLARATION.BOGEY) ? HIGHLIGHT_PURPLE : HIGHLIGHT_TEAL
    const symColor = highlightedIds.has(id) ? highlightColor : color

    const dbEntry = unitDb[unit.name]
    if (dbEntry) {
      if (dbEntry.acquisitionRange > 0 && !acqHidden.has(decl)) drawRangeRing(ctx, x, y, dbEntry.acquisitionRange, pixelsPerNm, color, true)
      if (dbEntry.engagementRange  > 0 && !engHidden.has(decl)) drawRangeRing(ctx, x, y, dbEntry.engagementRange,  pixelsPerNm, color, false)
    }

    ctx.beginPath()
    ctx.arc(x, y, GROUND_RADIUS, 0, Math.PI * 2)
    ctx.globalAlpha = 0.4
    ctx.fillStyle   = symColor
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.strokeStyle = symColor
    ctx.lineWidth   = 1
    ctx.stroke()
  }
}
