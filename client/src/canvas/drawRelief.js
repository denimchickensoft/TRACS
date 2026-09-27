import { projectRingCached, screenBoundsOfBbox } from '../utils/projection.js'

const RELIEF_COLOR_FALLBACK = '#88AA88'

/**
 * Shaded terrain-relief layer. Regions are nested elevation bands; we fill each
 * with a single hue at low alpha so the fills accumulate — higher terrain sits
 * under more bands and reads darker (a single-hue hypsometric wash). No labels.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object}   view    { centerLat, centerLng, pixelsPerNm, width, height }
 * @param {object[]} relief  array of { elev, rings, bbox }
 * @param {boolean}  visible
 * @param {number}   brite   0–100
 */
export function drawRelief(ctx, view, relief, visible, brite = 40, colors = null) {
  if (!visible || !relief.length || brite <= 0) return

  const { width, height } = view
  const entry = colors?.RELIEF
  const color = entry?.fill ?? entry?.stroke ?? RELIEF_COLOR_FALLBACK

  // Additive per-band alpha: each nested band adds a little ink, so areas
  // covered by many bands (high terrain) build toward opaque.
  const perBand = Math.min(0.12, (brite / 100) * 0.09)

  ctx.save()
  ctx.fillStyle   = color
  ctx.globalAlpha = perBand

  for (const region of relief) {
    const { x0, x1, y0, y1 } = screenBoundsOfBbox(region.bbox, view)
    if (x1 < -5 || x0 > width + 5 || y1 < -5 || y0 > height + 5) continue

    ctx.beginPath()
    for (const ring of region.rings) {
      const points = projectRingCached(ring, view)
      let first = true
      for (const { x, y } of points) {
        if (first) { ctx.moveTo(x, y); first = false }
        else ctx.lineTo(x, y)
      }
      ctx.closePath()
    }
    ctx.fill('evenodd')
  }

  ctx.restore()
}
