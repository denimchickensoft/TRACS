import { latLngToCanvas, canvasToLatLng } from './projection.js'

const M_PER_S_TO_KT = 1.94384

function resolveEndpoint(ep, units) {
  if (ep.unitId != null) {
    const unit = units[ep.unitId]
    if (!unit?.position) return null
    return { lat: unit.position.lat, lng: unit.position.lng, speed: unit.speed ?? null }
  }
  return { lat: ep.lat, lng: ep.lng, speed: null }
}

function trueBearing(lat0, lng0, lat1, lng1) {
  const dLng = (lng1 - lng0) * Math.PI / 180
  const φ0   = lat0 * Math.PI / 180
  const φ1   = lat1 * Math.PI / 180
  const y    = Math.sin(dLng) * Math.cos(φ1)
  const x    = Math.cos(φ0) * Math.sin(φ1) - Math.sin(φ0) * Math.cos(φ1) * Math.cos(dLng)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}

function rangeNm(lat0, lng0, lat1, lng1) {
  const dLat   = (lat1 - lat0) * 60
  const midLat = ((lat0 + lat1) / 2) * Math.PI / 180
  const dLng   = (lng1 - lng0) * 60 * Math.cos(midLat)
  return Math.sqrt(dLat * dLat + dLng * dLng)
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
 * @param {string}  color      CSS color for lines and labels
 */
export function drawRbls(ctx, view, rbls, rblWip, rblCursor, units, csTools = 3) {
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

    const dist    = rangeNm(ep0.lat, ep0.lng, ep1.lat, ep1.lng)
    const magBrg  = ((trueBearing(ep0.lat, ep0.lng, ep1.lat, ep1.lng) - declinationDeg) % 360 + 360) % 360
    const hdg     = String(Math.round(magBrg)).padStart(3, '0')
    const distStr = dist.toFixed(2)

    let label = `${hdg}/${distStr}`

    // ETA only when exactly one endpoint is a live track with groundspeed
    const p0Track = rbl.p0.unitId != null && ep0.speed != null && ep0.speed > 0
    const p1Track = rbl.p1.unitId != null && ep1.speed != null && ep1.speed > 0
    if (p0Track !== p1Track) {
      const kt  = (p0Track ? ep0.speed : ep1.speed) * M_PER_S_TO_KT
      label += `/${Math.round(60 * dist / kt)}`
    }

    label += `-${i + 1}`

    ctx.fillText(label, c1.x + 4, c1.y - 4)
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

      const dist   = rangeNm(ep0.lat, ep0.lng, curLat, curLng)
      const magBrg = ((trueBearing(ep0.lat, ep0.lng, curLat, curLng) - declinationDeg) % 360 + 360) % 360
      const label  = `${String(Math.round(magBrg)).padStart(3, '0')}/${dist.toFixed(2)}`
      ctx.fillText(label, rblCursor.x + 4, rblCursor.y - 4)
    }
  }

  ctx.restore()
}
