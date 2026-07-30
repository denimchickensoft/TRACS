'use strict'

// Software rasterizer for baking vector layers (relief bands, coastlines,
// roads/water) into a flat RGBA basemap image at build time — see
// buildAbmBasemap.js. No canvas/cairo dependency: this project avoids native
// image libs for one-shot build tooling (writeBMP in buildReliefMap.js is the
// same call), and the two primitives needed here (even-odd polygon fill,
// thin line stroke) are small enough to hand-roll.

// ── Alpha compositing (source-over, matches canvas globalAlpha fills) ───────
function blendPixel(buf, idx, r, g, b, a) {
  if (a <= 0) return
  const dstA = buf[idx + 3] / 255
  const outA = a + dstA * (1 - a)
  if (outA <= 0) { buf[idx + 3] = 0; return }
  buf[idx]     = (r * a + buf[idx]     * dstA * (1 - a)) / outA
  buf[idx + 1] = (g * a + buf[idx + 1] * dstA * (1 - a)) / outA
  buf[idx + 2] = (b * a + buf[idx + 2] * dstA * (1 - a)) / outA
  buf[idx + 3] = outA * 255
}

// ── Even-odd scanline polygon fill (matches ctx.fill('evenodd')) ────────────
// rings: array of rings, each an array of [x,y] pixel points (any winding,
// holes included the same way canvas's evenodd rule handles them — no need
// to distinguish outer/hole rings explicitly).
function fillPolygonEvenOdd(buf, width, height, rings, r, g, b, a) {
  let minY = Infinity, maxY = -Infinity
  for (const ring of rings) {
    for (const [, y] of ring) { if (y < minY) minY = y; if (y > maxY) maxY = y }
  }
  minY = Math.max(0, Math.floor(minY))
  maxY = Math.min(height - 1, Math.ceil(maxY))
  if (minY > maxY) return

  for (let y = minY; y <= maxY; y++) {
    const scanY = y + 0.5
    const xs = []
    for (const ring of rings) {
      const n = ring.length
      for (let i = 0; i < n; i++) {
        const [x1, y1] = ring[i]
        const [x2, y2] = ring[(i + 1) % n]
        if (y1 === y2) continue
        if ((scanY >= y1 && scanY < y2) || (scanY >= y2 && scanY < y1)) {
          xs.push(x1 + (scanY - y1) * (x2 - x1) / (y2 - y1))
        }
      }
    }
    xs.sort((p, q) => p - q)
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = Math.max(0, Math.round(xs[i]))
      const x1 = Math.min(width, Math.round(xs[i + 1]))
      const rowBase = y * width
      for (let x = x0; x < x1; x++) blendPixel(buf, (rowBase + x) * 4, r, g, b, a)
    }
  }
}

// ── Thin polyline stroke (Bresenham, optional 3x3 thickening) ───────────────
function strokeLine(buf, width, height, points, r, g, b, a, thick = false) {
  const plot = (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return
    blendPixel(buf, (y * width + x) * 4, r, g, b, a)
  }
  for (let i = 0; i + 1 < points.length; i++) {
    let [x0, y0] = points[i]
    const [x1, y1] = points[i + 1]
    x0 = Math.round(x0); y0 = Math.round(y0)
    const ex1 = Math.round(x1), ey1 = Math.round(y1)
    const dx = Math.abs(ex1 - x0), dy = -Math.abs(ey1 - y0)
    const sx = x0 < ex1 ? 1 : -1
    const sy = y0 < ey1 ? 1 : -1
    let err = dx + dy
    let cx = x0, cy = y0
    for (;;) {
      plot(cx, cy)
      if (thick) { plot(cx + 1, cy); plot(cx, cy + 1) }
      if (cx === ex1 && cy === ey1) break
      const e2 = 2 * err
      if (e2 >= dy) { err += dy; cx += sx }
      if (e2 <= dx) { err += dx; cy += sy }
    }
  }
}

module.exports = { fillPolygonEvenOdd, strokeLine, blendPixel }
