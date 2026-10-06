import { latLngToCanvas } from '../../../../utils/projection.js'
import { MS_TO_KT as M_PER_S_TO_KT, formatDistance } from '../../../../utils/units.js'

const NM_PER_DEG_LAT  = 60

// ── Math helpers ─────────────────────────────────────────────────────────────

function toNm(lat, lng, cosLat) {
  return { n: lat * NM_PER_DEG_LAT, e: lng * NM_PER_DEG_LAT * cosLat }
}

function fromNm(n, e, cosLat) {
  return { lat: n / NM_PER_DEG_LAT, lng: e / (NM_PER_DEG_LAT * cosLat) }
}

/**
 * Compute the closest approach between two moving aircraft sharing the same time.
 *
 * Both aircraft move simultaneously, so we minimize over a single parameter t:
 *   sep(t) = ||(P0 - P1) + t*(D0 - D1)||
 *   t_min  = -(w · Drel) / |Drel|²   where w = P0-P1, Drel = D0-D1
 *
 * Returns:
 *   past  — true when closest approach is already behind (t < 0)
 *   cp0   — { lat, lng } where u0 is at closest approach (clamped to now if past)
 *   cp1   — { lat, lng } where u1 is at closest approach (clamped to now if past)
 *   dist  — NM separation at actual closest approach
 */
function closestApproach(u0, u1) {
  const refLat = (u0.position.lat + u1.position.lat) / 2
  const cosLat = Math.cos(refLat * Math.PI / 180)

  const p0 = toNm(u0.position.lat, u0.position.lng, cosLat)
  const p1 = toNm(u1.position.lat, u1.position.lng, cosLat)

  // Velocity in NM/s — DCS track: radians, 0 = North, clockwise
  const s0 = (u0.speed ?? 0) * M_PER_S_TO_KT / 3600
  const s1 = (u1.speed ?? 0) * M_PER_S_TO_KT / 3600
  const d0   = { n: s0 * Math.cos(u0.track ?? 0), e: s0 * Math.sin(u0.track ?? 0) }
  const d1   = { n: s1 * Math.cos(u1.track ?? 0), e: s1 * Math.sin(u1.track ?? 0) }

  // Relative position and velocity
  const w    = { n: p0.n - p1.n, e: p0.e - p1.e }
  const drel = { n: d0.n - d1.n, e: d0.e - d1.e }
  const drel2 = drel.n*drel.n + drel.e*drel.e  // |Drel|²

  // Time to closest approach (seconds); negative → already past
  const t = drel2 > 1e-12 ? -(w.n*drel.n + w.e*drel.e) / drel2 : 0
  const past = t < 0

  // Draw positions clamped to now; distance from the real (unclamped) approach
  const tDraw = Math.max(0, t)
  const cp0nm = { n: p0.n + tDraw * d0.n, e: p0.e + tDraw * d0.e }
  const cp1nm = { n: p1.n + tDraw * d1.n, e: p1.e + tDraw * d1.e }
  const rp0nm = { n: p0.n + t     * d0.n, e: p0.e + t     * d0.e }
  const rp1nm = { n: p1.n + t     * d1.n, e: p1.e + t     * d1.e }

  const dist = Math.sqrt((rp0nm.n-rp1nm.n)**2 + (rp0nm.e-rp1nm.e)**2)

  return {
    past,
    cp0:  fromNm(cp0nm.n, cp0nm.e, cosLat),
    cp1:  fromNm(cp1nm.n, cp1nm.e, cosLat),
    cur0: { lat: u0.position.lat, lng: u0.position.lng },
    cur1: { lat: u1.position.lat, lng: u1.position.lng },
    dist,
  }
}

// ── Drawing helpers ───────────────────────────────────────────────────────────

function line(ctx, x0, y0, x1, y1) {
  ctx.beginPath()
  ctx.moveTo(x0, y0)
  ctx.lineTo(x1, y1)
  ctx.stroke()
}

function triangle(ctx, cx, cy, r) {
  ctx.beginPath()
  ctx.moveTo(cx, cy - r)
  ctx.lineTo(cx - r * 0.866, cy + r * 0.5)
  ctx.lineTo(cx + r * 0.866, cy + r * 0.5)
  ctx.closePath()
  ctx.fill()
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Draw the MIN (minimum separation) tool on the tools canvas.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object}      view     { centerLat, centerLng, pixelsPerNm, width, height, declinationDeg? }
 * @param {object|null} minSep   { ac0: unitId, ac1: unitId } completed MIN
 * @param {object|null} minWip   { ac0: unitId } awaiting second click
 * @param {object|null} cursor   { x, y } canvas-pixel cursor for WIP preview
 * @param {object}      units    visible units keyed by id
 * @param {number}      csTools  0–5 character size index
 */
export function drawMinSep(ctx, view, minSep, minWip, cursor, units, csTools = 3) {
  if (!minSep && !minWip) return

  const fontPx = 10 + csTools * 2
  const triR   = fontPx * 0.4

  ctx.save()
  ctx.strokeStyle  = '#808080'
  ctx.fillStyle    = '#808080'
  ctx.lineWidth    = 1.0
  ctx.font         = `${fontPx}px monospace`
  ctx.textAlign    = 'center'
  ctx.textBaseline = 'middle'

  // ── WIP preview — line from ac0 to cursor ────────────────────────
  if (minWip && cursor) {
    const u0 = units[minWip.ac0]
    if (u0?.position) {
      const c0 = latLngToCanvas(u0.position.lat, u0.position.lng, view)
      line(ctx, c0.x, c0.y, cursor.x, cursor.y)
    }
  }

  // ── Completed MIN ─────────────────────────────────────────────────
  if (!minSep) { ctx.restore(); return }

  const u0 = units[minSep.ac0]
  const u1 = units[minSep.ac1]
  if (!u0?.position || !u1?.position) { ctx.restore(); return }

  const { past, cp0, cp1, cur0, cur1, dist } = closestApproach(u0, u1)
  const distStr = formatDistance(dist, view.unitSystem, 2)

  if (past) {
    // Single line between current positions + NO XING label
    const c0 = latLngToCanvas(cur0.lat, cur0.lng, view)
    const c1 = latLngToCanvas(cur1.lat, cur1.lng, view)
    line(ctx, c0.x, c0.y, c1.x, c1.y)
    const mx = (c0.x + c1.x) / 2
    const my = (c0.y + c1.y) / 2
    ctx.fillText('NO XING', mx, my - fontPx * 0.7)
    ctx.fillText(distStr,   mx, my + fontPx * 0.7)
  } else {
    // Lines: cur0→cp0, cp0→cp1 (the sep line), cp1→cur1
    const c0  = latLngToCanvas(cur0.lat, cur0.lng, view)
    const c1  = latLngToCanvas(cur1.lat, cur1.lng, view)
    const cc0 = latLngToCanvas(cp0.lat,  cp0.lng,  view)
    const cc1 = latLngToCanvas(cp1.lat,  cp1.lng,  view)

    line(ctx, c0.x,  c0.y,  cc0.x, cc0.y)
    line(ctx, cc0.x, cc0.y, cc1.x, cc1.y)
    line(ctx, c1.x,  c1.y,  cc1.x, cc1.y)

    triangle(ctx, cc0.x, cc0.y, triR)
    triangle(ctx, cc1.x, cc1.y, triR)

    const mx = (cc0.x + cc1.x) / 2
    const my = (cc0.y + cc1.y) / 2
    ctx.fillText(distStr, mx, my - fontPx * 0.7)
  }

  ctx.restore()
}
