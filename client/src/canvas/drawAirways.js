import { latLngToCanvas } from '../utils/projection.js'

const AIRWAY_FALLBACK = { V: '#66FF99', J: '#FFDD44', B: '#AABBCC' }

// Extra on-screen length a segment needs beyond its label's text width
// before it gets labelled, so short legs near fixes stay clean.
const LABEL_PAD_PX = 12

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object}  view        { centerLat, centerLng, pixelsPerNm, width, height }
 * @param {object}  airways     { V: [...], J: [...], B: [...] }
 * @param {object}  visible     { V: bool, J: bool, B: bool }
 * @param {number}  brite       0–100
 * @param {object}  colors      airway color config
 * @param {boolean} lblVisible  whether labels are toggled on
 * @param {number}  csMap       0–5 char size; 0 suppresses labels
 * @param {Set}     pinned      upper-case airway names drawn regardless of `visible`
 */
export function drawAirways(ctx, view, airways, visible, brite = 50, colors = null, lblVisible = false, csMap = 0, pinned = null) {
  if (!airways || brite <= 0) return

  const { width, height } = view
  const alpha = Math.max(0, Math.min(1, brite / 100))
  const labelOn = lblVisible && csMap > 0

  // Label candidates keyed by the segment's unordered endpoints, so airways
  // sharing a fix pair (e.g. V66 and J70 on one leg) stack instead of overprinting.
  const bySegment = new Map()

  for (const type of ['V', 'J', 'B']) {
    const segs = airways[type]
    if (!segs?.length) continue
    const classOn = !!visible?.[type]
    if (!classOn && !pinned?.size) continue

    const airwayEntry = colors?.[`AIRWAYS_${type}`]
    const color = airwayEntry?.stroke ?? AIRWAY_FALLBACK[type]

    ctx.save()
    ctx.globalAlpha = alpha
    ctx.strokeStyle = color
    ctx.setLineDash((airwayEntry?.dash ?? []).map(v => v * view.pixelsPerNm))
    ctx.lineWidth   = 1.0

    ctx.beginPath()
    for (const seg of segs) {
      if (!classOn && !pinned.has(seg.name.toUpperCase())) continue
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

      if (!labelOn) continue
      const mx = (p1.x + p2.x) / 2
      const my = (p1.y + p2.y) / 2
      if (mx < 0 || mx > width || my < 0 || my > height) continue
      const a = `${seg.from[0].toFixed(4)},${seg.from[1].toFixed(4)}`
      const b = `${seg.to[0].toFixed(4)},${seg.to[1].toFixed(4)}`
      const key = a < b ? `${a}|${b}` : `${b}|${a}`
      let entry = bySegment.get(key)
      if (!entry) {
        entry = { p1, p2, mx, my, labels: [] }
        bySegment.set(key, entry)
      }
      if (!entry.labels.some(l => l.name === seg.name)) entry.labels.push({ name: seg.name, color })
    }
    ctx.stroke()
    ctx.restore()
  }

  if (!labelOn || !bySegment.size) return

  const fontSize = 6 + csMap * 2
  const lineH    = fontSize + 2

  ctx.save()
  ctx.globalAlpha  = alpha
  ctx.font         = `${fontSize}px "Roboto Mono", monospace`
  ctx.textAlign    = 'center'
  ctx.textBaseline = 'middle'

  for (const { p1, p2, mx, my, labels } of bySegment.values()) {
    const lenPx  = Math.hypot(p2.x - p1.x, p2.y - p1.y)
    const widest = Math.max(...labels.map(l => ctx.measureText(l.name).width))
    if (lenPx < widest + LABEL_PAD_PX) continue

    let angle = Math.atan2(p2.y - p1.y, p2.x - p1.x)
    if (angle >  Math.PI / 2) angle -= Math.PI
    if (angle < -Math.PI / 2) angle += Math.PI

    ctx.save()
    ctx.translate(mx, my)
    ctx.rotate(angle)
    labels.forEach(({ name, color }, i) => {
      ctx.fillStyle = color
      ctx.fillText(name, 0, -(fontSize / 2 + 3 + i * lineH))
    })
    ctx.restore()
  }

  ctx.restore()
}
