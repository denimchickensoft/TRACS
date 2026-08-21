import { latLngToCanvas } from './projection.js'
import { fixSymbolType, drawFixSymbol } from './fixSymbol.js'

const PROC_FALLBACKS = {
  SID:   { stroke: '#00FF88' },
  STAR:  { stroke: '#88FFFF' },
  APPCH: { stroke: '#FFFF44' },
}

const TRI_GAP = 6  // px clearance between line endpoint and triangle center

// Draw a single polyline, switching to dashed when entering missed approach legs.
// Leaves a gap around any point that has an id (fix triangle).
function drawPolyline(ctx, view, pts, missedDash) {
  if (!pts || pts.length < 2) return

  const cpts   = pts.map(p => latLngToCanvas(p.lat, p.lon, view))
  let inMissed = false
  let pathOpen = false

  function flushPath() {
    if (pathOpen) { ctx.stroke(); pathOpen = false }
  }

  ctx.setLineDash([])

  for (let i = 0; i < cpts.length - 1; i++) {
    const pa         = cpts[i], pb = cpts[i + 1]
    const aHasTri    = !!pts[i].id
    const bHasTri    = !!pts[i + 1].id
    const nextMissed = !!pts[i + 1].missed
    const dashChange = nextMissed !== inMissed

    if (dashChange) {
      flushPath()
      ctx.setLineDash(nextMissed ? missedDash : [])
      inMissed = nextMissed
    }

    let sx = pa.x, sy = pa.y, ex = pb.x, ey = pb.y
    if (aHasTri || bHasTri) {
      const dx = pb.x - pa.x, dy = pb.y - pa.y
      const len = Math.hypot(dx, dy)
      if (len <= TRI_GAP * 2) { flushPath(); continue }
      if (aHasTri) { sx = pa.x + dx * TRI_GAP / len; sy = pa.y + dy * TRI_GAP / len }
      if (bHasTri) { ex = pb.x - dx * TRI_GAP / len; ey = pb.y - dy * TRI_GAP / len }
    }

    if (aHasTri) flushPath()
    if (!pathOpen) { ctx.beginPath(); ctx.moveTo(sx, sy); pathOpen = true }
    ctx.lineTo(ex, ey)
    if (bHasTri) flushPath()
  }

  flushPath()
  ctx.setLineDash([])
}

// Draw fix symbols and ident labels for named waypoints.
function drawFixLabels(ctx, view, pts) {
  for (const pt of pts) {
    if (!pt.id) continue
    const { x, y } = latLngToCanvas(pt.lat, pt.lon, view)
    drawFixSymbol(ctx, x, y, fixSymbolType(pt.id))
    ctx.fillText(pt.id, x + 4, y - 3)
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object}   view           { centerLat, centerLng, pixelsPerNm, width, height }
 * @param {object}   raw            full procedures JSON { SID, STAR, APPCH }
 * @param {object}   sidGroups      { "ATUD3": ["ATUD3F", ...] }
 * @param {object}   starGroups
 * @param {object}   appchGroups    { "ILS 13": ["I13L", "I13R"] }
 * @param {Set}      visible        set of group keys like "SID:ATUD3"
 * @param {number}   brite          0–100
 * @param {number}   csMap          0–5
 * @param {object}   colors         palette (optional)
 * @param {Set}      commandVisible set of individual proc keys shown via .proc command
 */
export function drawProcedures(ctx, view, raw, sidGroups, starGroups, appchGroups, visible, brite = 50, csMap = 2, colors = null, commandVisible = null) {
  const hasGroupVisible   = visible?.size > 0
  const hasCommandVisible = commandVisible?.size > 0
  if (!raw || (!hasGroupVisible && !hasCommandVisible) || brite <= 0) return

  const alpha    = Math.max(0, Math.min(1, brite / 100))
  const fontSize = 6 + csMap * 2
  const missedDash = [4, 4]

  const categoryDefs = [
    { category: 'SID',   groups: sidGroups,   raw: raw.SID   },
    { category: 'STAR',  groups: starGroups,  raw: raw.STAR  },
    { category: 'APPCH', groups: appchGroups, raw: raw.APPCH },
  ]

  for (const { category, groups, raw: catRaw } of categoryDefs) {
    if (!catRaw) continue

    const paletteKey = `PROC_${category}`
    const stroke     = colors?.[paletteKey]?.stroke ?? PROC_FALLBACKS[category].stroke

    ctx.save()
    ctx.globalAlpha  = alpha
    ctx.strokeStyle  = stroke
    ctx.fillStyle    = stroke
    ctx.lineWidth    = 1.0

    if (csMap > 0) {
      ctx.font         = `${fontSize}px "Roboto Mono", monospace`
      ctx.textAlign    = 'left'
      ctx.textBaseline = 'alphabetic'
    }

    for (const [groupKey, procKeys] of Object.entries(groups)) {
      const visKey = `${category}:${groupKey}`
      if (!visible.has(visKey)) continue

      for (const procKey of procKeys) {
        const proc = catRaw[procKey]
        if (!proc) continue
        for (const pts of Object.values(proc.transitions)) {
          drawPolyline(ctx, view, pts, missedDash)
          if (csMap > 0) drawFixLabels(ctx, view, pts)
        }
      }
    }

    // Individual procedures shown via .proc command (skip if already group-visible)
    if (hasCommandVisible) {
      for (const procKey of commandVisible) {
        const proc = catRaw[procKey]
        if (!proc) continue
        // Skip if this proc's group is already drawn above
        const base   = procKey.slice(0, -1)
        const visKey = `${category}:${base}`
        if (visible.has(visKey)) continue
        // For APPCH, also skip if the group-key form was already drawn
        const alreadyDrawn = Object.entries(groups).some(([gk, keys]) =>
          keys.includes(procKey) && visible.has(`${category}:${gk}`)
        )
        if (alreadyDrawn) continue
        for (const pts of Object.values(proc.transitions)) {
          drawPolyline(ctx, view, pts, missedDash)
          if (csMap > 0) drawFixLabels(ctx, view, pts)
        }
      }
    }

    ctx.restore()
  }
}
