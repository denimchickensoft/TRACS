import { latLngToCanvas } from './projection.js'
import { HIGHLIGHT_TEAL } from '../constants.js'

/**
 * Draw an octagon (8-sided polygon) centred at (cx, cy).
 * @param {number} rotationDeg  rotation offset in degrees
 */
function drawOctagon(ctx, cx, cy, radius, rotationDeg) {
  const sides = 8
  const rotOffset = rotationDeg * Math.PI / 180
  ctx.beginPath()
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2 + rotOffset
    const x = cx + radius * Math.cos(angle)
    const y = cy + radius * Math.sin(angle)
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
}

const M_PER_S_TO_KT = 1.94384

/**
 * Layer 2 — PTLs, contacts, and history trails.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} view       { centerLat, centerLng, pixelsPerNm, width, height }
 * @param {Object} units      filtered visible units { [id]: unit }
 * @param {Object} history    { [id]: [{lat,lng}, ...] }  newest-first
 * @param {object} visual     profile.visual
 * @param {Object} symbolMap  { [id]: { sym, mine } }
 * @param {number} britePos   0–1 opacity for interior character
 * @param {number} csPos      0–5 character size index
 * @param {{ minutes: number, mode: 'OWN'|'ALL'|null, ownership: object, myPosition: string }|null} ptlOpts
 */
const BLINK_DIM    = '#C0C0C0'
const PO_BLINK_ON  = '#FFFF00'
const PO_BLINK_OFF = '#808000'

export function drawContacts(ctx, view, units, history, visual, symbolMap = {}, britePos = 1.0, csPos = 3, ptlOpts = null, historyLimit = 5, briteHst = 0.8, blinkingUids = null, blinkOn = true, poReceivingUids = null, highlightedUids = null) {
  const width  = ctx.canvas.width
  const height = ctx.canvas.height
  const { colors, symbol } = visual
  const rotDeg     = symbol.rotationDeg      ?? 22.5
  const filled     = symbol.filled           ?? true
  const radius     = (symbol.diameter        ?? 13) / 2
  const histRadius = (symbol.historyDiameter ?? 8)  / 2

  ctx.clearRect(0, 0, width, height)

  // ── PTL first pass — drawn under everything ───────────────────────
  if (ptlOpts && ptlOpts.mode && ptlOpts.minutes > 0) {
    const { minutes, mode, ownership, myPosition } = ptlOpts
    ctx.strokeStyle = colors.ptlLine ?? colors.contact
    ctx.lineWidth   = 0.8

    for (const [id, unit] of Object.entries(units)) {
      const pos = unit.position
      if (!pos || unit.track == null || !unit.speed) continue

      // Ownership filter
      if (mode === 'OWN' && ownership[String(id)] !== myPosition) continue

      const { x, y } = latLngToCanvas(pos.lat, pos.lng, view)
      if (x < -100 || x > width + 100 || y < -100 || y > height + 100) continue

      // Project endpoint: speed (m/s) → kt → nm over ptl minutes
      const distNm     = (unit.speed * M_PER_S_TO_KT * minutes) / 60
      const headingRad = unit.track     // true track, radians, DCS-native (0=N, CW)
      const latRad     = pos.lat * Math.PI / 180
      const endLat     = pos.lat + (distNm / 60) * Math.cos(headingRad)
      const endLng     = pos.lng + (distNm / (60 * Math.cos(latRad))) * Math.sin(headingRad)

      const end = latLngToCanvas(endLat, endLng, view)

      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(end.x, end.y)
      ctx.stroke()
    }
  }

  // ── Contacts + history ────────────────────────────────────────────
  for (const [id, unit] of Object.entries(units)) {
    const pos = unit.position
    if (!pos) continue

    const { x, y } = latLngToCanvas(pos.lat, pos.lng, view)
    if (x < -50 || x > width + 50 || y < -50 || y > height + 50) continue

    // --- History trail ---
    const trail = history[id] || []
    const maxColor = colors.historyTrail.length - 1
    for (let i = 0; i < trail.length && i < historyLimit; i++) {
      const hp = latLngToCanvas(trail[i].lat, trail[i].lng, view)
      ctx.globalAlpha = Math.max(0, Math.min(1, briteHst))
      ctx.fillStyle = colors.historyTrail[Math.min(i, maxColor)]
      drawOctagon(ctx, hp.x, hp.y, histRadius, rotDeg)
      ctx.fill()
      ctx.globalAlpha = 1.0
    }

    // --- Contact symbol --- (highlight does NOT touch the symbol shape/color —
    // only the interior text, below, per 2026-07-29 direction)
    const isBlinkUnit    = blinkingUids?.has(String(id)) ?? false
    const isPoUnit       = poReceivingUids?.has(String(id)) ?? false
    const isHighlighted  = highlightedUids?.has(String(id)) ?? false
    drawOctagon(ctx, x, y, radius, rotDeg)
    if (filled) {
      ctx.fillStyle = colors.contact
      ctx.fill()
    } else {
      ctx.strokeStyle = colors.contact
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    // --- Interior symbol: '*' unassociated, position letter if owned ---
    const entry      = symbolMap[id] ?? { sym: '*', mine: false }
    const isAsterisk = entry.sym === '*'
    const letterPx   = 10 + csPos * 2
    const fontPx     = isAsterisk ? Math.round(letterPx * 1.76) : letterPx
    const baseColor  = entry.mine ? colors.fdbText : colors.ldbText
    const letColor   = isHighlighted ? HIGHLIGHT_TEAL
                     : isPoUnit      ? (blinkOn ? PO_BLINK_ON : PO_BLINK_OFF)
                     : isBlinkUnit   ? (blinkOn ? colors.fdbText : BLINK_DIM)
                     : baseColor
    ctx.font         = `bold ${fontPx}px "Roboto Mono", monospace`
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'alphabetic'
    ctx.globalAlpha  = Math.max(0, Math.min(1, britePos))
    ctx.fillStyle    = letColor
    const m      = ctx.measureText(entry.sym)
    const yOffset = (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2
    ctx.fillText(entry.sym, x, y + yOffset)
    ctx.globalAlpha  = 1.0
  }
}
