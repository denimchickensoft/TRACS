import { latLngToCanvas } from '../../../../utils/projection.js'

/**
 * Layer 1 — static range rings.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} view      { centerLat, centerLng, pixelsPerNm, width, height }
 * @param {number} rangeNm
 * @param {number} ringSpacingNm
 * @param {object} visual    profile.visual
 * @param {{ lat: number, lng: number } | null} rrCenter  optional ring-center override
 */
export function drawRangeRings(ctx, view, rangeNm, ringSpacingNm, visual, rrCenter = null, briteRr = 70) {
  const { pixelsPerNm } = view
  const width  = ctx.canvas.width
  const height = ctx.canvas.height

  // Ring center in canvas pixels — defaults to scope center
  const { x: cx, y: cy } = rrCenter
    ? latLngToCanvas(rrCenter.lat, rrCenter.lng, view)
    : { x: width / 2, y: height / 2 }

  // briteRr 0–100: 0 = black, 100 = white
  const gray     = Math.round(Math.max(0, Math.min(100, briteRr)) / 100 * 255)
  const ringColor = `rgb(${gray},${gray},${gray})`

  // Background is provided by CSS on the scope container — don't fill here.
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)

  const rrStyle = visual.rangeRings ?? {}
  ctx.strokeStyle = ringColor
  ctx.lineWidth   = rrStyle.lineWidth ?? 0.5
  if (!(rrStyle.solid ?? true)) ctx.setLineDash([4, 6])

  // Extend rings to cover the farthest canvas corner from the ring center,
  // so panning never leaves part of the canvas without rings.
  const cornerDists = [
    Math.hypot(cx, cy),
    Math.hypot(width - cx, cy),
    Math.hypot(cx, height - cy),
    Math.hypot(width - cx, height - cy),
  ]
  const maxPx = Math.max(...cornerDists)
  const drawOutNm = Math.max(rangeNm, maxPx / pixelsPerNm)

  for (let r = ringSpacingNm; r <= drawOutNm + ringSpacingNm * 0.5; r += ringSpacingNm) {
    const px = r * pixelsPerNm
    ctx.beginPath()
    ctx.arc(cx, cy, px, 0, Math.PI * 2)
    ctx.stroke()
  }

  ctx.setLineDash([])

}
