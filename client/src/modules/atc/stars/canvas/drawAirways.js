import { latLngToCanvas } from '../../../../utils/projection.js'

const AIRWAY_FALLBACK = { V: '#66FF99', J: '#FFDD44', B: '#AABBCC' }

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object}  view        { centerLat, centerLng, pixelsPerNm, width, height }
 * @param {object}  airways     { V: [...], J: [...], B: [...] }
 * @param {object}  visible     { V: bool, J: bool, B: bool }
 * @param {number}  brite       0–100
 * @param {object}  colors      airway color config
 * @param {boolean} lblVisible  whether LBL is toggled on
 * @param {number}  csMap       0–5 char size; 0 suppresses labels
 */
export function drawAirways(ctx, view, airways, visible, brite = 50, colors = null, lblVisible = false, csMap = 0) {
  if (!airways || brite <= 0) return

  const { width, height } = view
  const alpha = Math.max(0, Math.min(1, brite / 100))

  for (const type of ['V', 'J', 'B']) {
    if (!visible[type]) continue
    const segs = airways[type]
    if (!segs?.length) continue

    const airwayEntry = colors?.[`AIRWAYS_${type}`]
    const color = airwayEntry?.stroke ?? AIRWAY_FALLBACK[type]

    ctx.save()
    ctx.globalAlpha = alpha
    ctx.strokeStyle = color
    ctx.setLineDash((airwayEntry?.dash ?? []).map(v => v * view.pixelsPerNm))
    ctx.lineWidth   = 1.0

    ctx.beginPath()
    for (const seg of segs) {
      const [fromLon, fromLat] = seg.from
      const [toLon,   toLat]   = seg.to
      const p1 = latLngToCanvas(fromLat, fromLon, view)
      const p2 = latLngToCanvas(toLat,   toLon,   view)

      // Cull segments entirely off-screen
      if (p1.x < -200 && p2.x < -200) continue
      if (p1.x > width + 200 && p2.x > width + 200) continue
      if (p1.y < -200 && p2.y < -200) continue
      if (p1.y > height + 200 && p2.y > height + 200) continue

      ctx.moveTo(p1.x, p1.y)
      ctx.lineTo(p2.x, p2.y)
    }
    ctx.stroke()
    ctx.restore()

    if (!lblVisible || csMap <= 0) continue

    // Label each airway name once — pick the visible segment whose midpoint
    // is closest to the screen centre.
    const fontSize  = 6 + csMap * 2
    const cx = width / 2, cy = height / 2
    const byName = new Map()

    for (const seg of segs) {
      const p1 = latLngToCanvas(seg.from[1], seg.from[0], view)
      const p2 = latLngToCanvas(seg.to[1],   seg.to[0],   view)
      const mx = (p1.x + p2.x) / 2
      const my = (p1.y + p2.y) / 2
      if (mx < -50 || mx > width + 50 || my < -50 || my > height + 50) continue
      const dist = Math.hypot(mx - cx, my - cy)
      if (!byName.has(seg.name) || dist < byName.get(seg.name).dist) {
        byName.set(seg.name, { name: seg.name, p1, p2, mx, my, dist })
      }
    }

    ctx.save()
    ctx.globalAlpha = alpha
    ctx.fillStyle   = color
    ctx.font        = `${fontSize}px "Roboto Mono", monospace`
    ctx.textAlign   = 'center'
    ctx.textBaseline = 'middle'

    for (const { name, p1, p2, mx, my } of byName.values()) {
      let angle = Math.atan2(p2.y - p1.y, p2.x - p1.x)
      if (angle >  Math.PI / 2) angle -= Math.PI
      if (angle < -Math.PI / 2) angle += Math.PI

      ctx.save()
      ctx.translate(mx, my)
      ctx.rotate(angle)
      ctx.fillText(name, 0, -(fontSize / 2 + 3))
      ctx.restore()
    }

    ctx.restore()
  }
}
