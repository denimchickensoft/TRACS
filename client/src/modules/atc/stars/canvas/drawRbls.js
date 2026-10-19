import { latLngToCanvas, canvasToLatLng } from '../../../../utils/projection.js'
import { gridBearingRangeNm, toMagneticFromTrue } from '../../../../utils/bearing.js'
import { MS_TO_KT as M_PER_S_TO_KT, distFromNm } from '../../../../utils/units.js'


function resolveEndpoint(ep, units) {
  if (ep.unitId != null) {
    const unit = units[ep.unitId]
    if (!unit?.position) return null
    return { lat: unit.position.lat, lng: unit.position.lng, speed: unit.speed ?? null }
  }
  return { lat: ep.lat, lng: ep.lng, speed: null }
}

// The readout sits on the opposite side of the endpoint from that track's
// datablock leader, so the two don't overlap (LDR DIR N puts it at about 5
// o'clock). A map point or the WIP cursor has no datablock and is placed as
// if its leader pointed N.
const LABEL_GAP = 8
const NO_LEADER_ANGLE_DEG = 270

function drawLabel(ctx, text, x, y, leaderAngleDeg) {
  const a  = ((leaderAngleDeg ?? NO_LEADER_ANGLE_DEG) + 180) * Math.PI / 180
  const nx = Math.cos(a)
  const ny = Math.sin(a)
  const vertical = Math.abs(nx) <= 0.1
  ctx.textAlign    = nx < -0.1 ? 'right' : 'left'
  ctx.textBaseline = ny > 0.1 ? 'top' : ny < -0.1 ? 'alphabetic' : 'middle'
  ctx.fillText(text, x + nx * LABEL_GAP + (vertical ? 4 : 0), y + ny * LABEL_GAP)
}

/**
 * Draw all completed RBLs and the WIP preview on the contacts canvas.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object}  view       { centerLat, centerLng, pixelsPerNm, width, height, declinationDeg? }
 * @param {Array}   rbls       [{ p0, p1 }] completed lines
 * @param {object|null} rblWip { p0 } awaiting second click
 * @param {object|null} rblCursor { x, y } canvas-pixel cursor for WIP preview
 * @param {object}  units      visible units keyed by id
 * @param {number}  csTools
 * @param {Function|null} getLeaderAngleDeg (unitId) => the datablock leader's
 *   resolved canvas angle in degrees, or null when the track has none
 */
export function drawRbls(ctx, view, rbls, rblWip, rblCursor, units, csTools = 3, getLeaderAngleDeg = null) {
  if (!rbls?.length && !rblWip) return

  const declinationDeg = view.declinationDeg ?? 0
  const fontPx  = 10 + csTools * 2

  // Stale-check: filter completed RBLs where a track endpoint has vanished.
  // (Caller should also persist this pruned list to avoid zombie RBLs across renders.)
  const liveRbls = rbls.filter((r) => {
    if (r.p0.unitId != null && !units[r.p0.unitId]?.position) return false
    if (r.p1.unitId != null && !units[r.p1.unitId]?.position) return false
    return true
  })

  ctx.save()
  ctx.strokeStyle = '#808080'
  ctx.fillStyle   = '#808080'
  ctx.lineWidth   = 1.0
  ctx.font        = `${fontPx}px monospace`
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign    = 'left'

  for (let i = 0; i < liveRbls.length; i++) {
    const rbl = liveRbls[i]
    const ep0 = resolveEndpoint(rbl.p0, units)
    const ep1 = resolveEndpoint(rbl.p1, units)
    if (!ep0 || !ep1) continue

    const c0 = latLngToCanvas(ep0.lat, ep0.lng, view)
    const c1 = latLngToCanvas(ep1.lat, ep1.lng, view)

    ctx.beginPath()
    ctx.moveTo(c0.x, c0.y)
    ctx.lineTo(c1.x, c1.y)
    ctx.stroke()

    const { gridBearingDeg, rangeNm: dist } = gridBearingRangeNm(ep0.lat, ep0.lng, ep1.lat, ep1.lng, view.theatre)
    const magBrg  = toMagneticFromTrue(gridBearingDeg, declinationDeg)
    const hdg     = String(Math.round(magBrg) || 360).padStart(3, '0')
    const distStr = distFromNm(dist, view.unitSystem).toFixed(2)

    let label = `${hdg}/${distStr}`

    // ETA only when exactly one endpoint is a live track with groundspeed
    const p0Track = rbl.p0.unitId != null && ep0.speed != null && ep0.speed > 0
    const p1Track = rbl.p1.unitId != null && ep1.speed != null && ep1.speed > 0
    if (p0Track !== p1Track) {
      const kt  = (p0Track ? ep0.speed : ep1.speed) * M_PER_S_TO_KT
      label += `/${Math.round(60 * dist / kt)}`
    }

    label += `-${i + 1}`

    const leaderAngleDeg = rbl.p1.unitId != null ? getLeaderAngleDeg?.(String(rbl.p1.unitId)) : null
    drawLabel(ctx, label, c1.x, c1.y, leaderAngleDeg)
  }

  // WIP preview — solid gray line from P0 to cursor with live label
  if (rblWip && rblCursor) {
    const ep0 = resolveEndpoint(rblWip.p0, units)
    if (ep0) {
      const c0 = latLngToCanvas(ep0.lat, ep0.lng, view)

      ctx.strokeStyle = '#808080'
      ctx.fillStyle   = '#808080'
      ctx.beginPath()
      ctx.moveTo(c0.x, c0.y)
      ctx.lineTo(rblCursor.x, rblCursor.y)
      ctx.stroke()

      // Resolve cursor back to lat/lng via the real projection inverse (full TM
      // inverse when the theatre has params) — must match how the endpoint
      // gets resolved on click (StarsScope.jsx's canvasToLatLng call), or the
      // WIP preview's bearing disagrees with the registered line's.
      const { lat: curLat, lng: curLng } = canvasToLatLng(rblCursor.x, rblCursor.y, view)

      const { gridBearingDeg, rangeNm: dist } = gridBearingRangeNm(ep0.lat, ep0.lng, curLat, curLng, view.theatre)
      const magBrg = toMagneticFromTrue(gridBearingDeg, declinationDeg)
      const label  = `${String(Math.round(magBrg) || 360).padStart(3, '0')}/${distFromNm(dist, view.unitSystem).toFixed(2)}`
      drawLabel(ctx, label, rblCursor.x, rblCursor.y, null)
    }
  }

  ctx.restore()
}
