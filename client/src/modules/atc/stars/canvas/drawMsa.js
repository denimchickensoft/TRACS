import { latLngToCanvas } from '../../../../utils/projection.js'
import { altFromFt } from '../../../../utils/units.js'

const MSA_COLOR_FALLBACK = '#FF8800'
const NM_TO_RAD = Math.PI / 10800.066  // 1 nm in radians (Earth radius 3440.065 nm)

function projectBearing(lat, lon, bearingDeg, distNm) {
  const d  = distNm * NM_TO_RAD
  const φ1 = lat * Math.PI / 180
  const λ1 = lon * Math.PI / 180
  const θ  = bearingDeg * Math.PI / 180
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2))
  return { lat: φ2 * 180 / Math.PI, lon: λ2 * 180 / Math.PI }
}

function midBearing(b1, b2) {
  const diff = ((b2 - b1) + 360) % 360
  return (b1 + diff / 2) % 360
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object}   view     { centerLat, centerLng, pixelsPerNm, width, height }
 * @param {object[]} msa      array of { icao, lat, lon, radiusNm, geometry, sectors }
 * @param {boolean}  visible
 * @param {number}   brite    0–100
 * @param {number}   csMap    0–5
 */
export function drawMsa(ctx, view, msa, visible, brite = 50, csMap = 2, colors = null) {
  if (!visible || !msa.length || brite <= 0) return

  const { width, height } = view
  const alpha    = Math.max(0, Math.min(1, brite / 100))
  const fontSize = 6 + csMap * 2

  const msaEntry = colors?.MSA
  ctx.save()
  const color = msaEntry?.stroke ?? MSA_COLOR_FALLBACK
  ctx.globalAlpha  = alpha
  ctx.strokeStyle  = color
  ctx.fillStyle    = color
  ctx.setLineDash((msaEntry?.dash ?? []).map(v => v * view.pixelsPerNm))
  ctx.lineWidth    = 1.0

  for (const ring of msa) {
    if (!ring.geometry?.length) continue

    const cpt     = latLngToCanvas(ring.lat, ring.lon, view)
    const radiusNm = ring.radiusNm ?? 25
    const radiusPx = radiusNm * view.pixelsPerNm

    if (
      cpt.x + radiusPx < -50 || cpt.x - radiusPx > width + 50 ||
      cpt.y + radiusPx < -50 || cpt.y - radiusPx > height + 50
    ) continue

    // Draw polygon ring
    ctx.beginPath()
    let first = true
    for (const [lon, lat] of ring.geometry) {
      const { x, y } = latLngToCanvas(lat, lon, view)
      if (first) { ctx.moveTo(x, y); first = false }
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.stroke()

    if (csMap <= 0) continue

    const sectors = ring.sectors ?? []

    // Sector boundary radial lines (only when > 1 sector)
    if (sectors.length > 1) {
      for (const s of sectors) {
        const ep = projectBearing(ring.lat, ring.lon, s.bearing, radiusNm)
        const ept = latLngToCanvas(ep.lat, ep.lon, view)
        ctx.beginPath()
        ctx.moveTo(cpt.x, cpt.y)
        ctx.lineTo(ept.x, ept.y)
        ctx.stroke()
      }
    }

    // Altitude labels — one per sector at arc midpoint (70% radius), or center for single-sector
    ctx.font         = `bold ${fontSize}px "Roboto Mono", monospace`
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'

    const label = ring.ident || ''

    if (sectors.length === 0) {
      if (label) ctx.fillText(label, cpt.x, cpt.y)
    } else if (sectors.length === 1) {
      const altText = `${Math.round(altFromFt(sectors[0].altFt, view.unitSystem) / 100)}`
      const lp  = projectBearing(ring.lat, ring.lon, 0, radiusNm * 0.4)
      const lpt = latLngToCanvas(lp.lat, lp.lon, view)
      ctx.fillText(altText, lpt.x, lpt.y)
      if (label) ctx.fillText(label, cpt.x, cpt.y + fontSize * 1.2)
    } else {
      for (let i = 0; i < sectors.length; i++) {
        const b1  = sectors[i].bearing
        const b2  = sectors[(i + 1) % sectors.length].bearing
        const mid = midBearing(b1, b2)
        const lp  = projectBearing(ring.lat, ring.lon, mid, radiusNm * 0.7)
        const lpt = latLngToCanvas(lp.lat, lp.lon, view)
        ctx.fillText(`${Math.round(altFromFt(sectors[i].altFt, view.unitSystem) / 100)}`, lpt.x, lpt.y)
      }
      if (label) ctx.fillText(label, cpt.x, cpt.y)
    }
  }

  ctx.restore()
}
