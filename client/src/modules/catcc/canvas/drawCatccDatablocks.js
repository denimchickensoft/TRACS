import { latLngToCanvas } from '../../atc/canvas/projection.js'

const M_TO_FT  = 3.28084
const MS_TO_KT = 1.94384

const SYMBOL_RADIUS  = 5     // px — matches circle radius in drawCatccContacts
const LEADER_LEN     = 16    // px — long enough that bbox near-edge clears symbol for all angles
const LEADER_GAP     = 2     // px gap between leader tip and bbox edge
const LINE_HEIGHT    = 11    // px between text lines
const TEXT_DIST      = SYMBOL_RADIUS + LEADER_LEN
const ASCENT         = 9     // approx ascent for 10px monospace
const DESCENT        = 2     // approx descent
const PADDING        = 2     // extra clearance around each bbox
const RADIAL_PENALTY = 1e6   // score penalty for hitting a radial line

const CANDIDATE_ANGLES = [-45, -135, -90, 0, 45, 180, 90, 135]
  .map((d) => d * Math.PI / 180)

function fmtAlt(metres) {
  if (metres == null) return '---'
  return String(Math.round((metres * M_TO_FT) / 100)).padStart(3, '0')
}

function fmtGs(mps) {
  if (mps == null) return '---'
  return String(Math.round(mps * MS_TO_KT))
}

// Axis-aligned bbox for a two-line label anchored at the leader tip.
// Text alignment flips so text always extends away from the symbol.
function labelBBox(lx1, ly1, angle, w1, w2) {
  const cosA = Math.cos(angle)
  const w    = Math.max(w1, w2)
  let left
  if      (cosA >  0.1) left = lx1
  else if (cosA < -0.1) left = lx1 - w
  else                  left = lx1 - w / 2
  return {
    x1: left - PADDING,
    y1: ly1 - ASCENT  - PADDING,
    x2: left + w      + PADDING,
    y2: ly1 + LINE_HEIGHT + DESCENT + PADDING,
    textX: lx1,
    align: cosA > 0.1 ? 'left' : cosA < -0.1 ? 'right' : 'center',
    lx1, ly1,
  }
}

function overlapArea(a, b) {
  const ox = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)
  const oy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1)
  return ox > 0 && oy > 0 ? ox * oy : 0
}

// Liang–Barsky segment–AABB intersection test.
function segmentHitsBBox(x0, y0, x1, y1, box) {
  const dx = x1 - x0, dy = y1 - y0
  let t0 = 0, t1 = 1
  for (const [p, q] of [[-dx, x0 - box.x1], [dx, box.x2 - x0], [-dy, y0 - box.y1], [dy, box.y2 - y0]]) {
    if (Math.abs(p) < 1e-9) {
      if (q < 0) return false
    } else {
      const t = q / p
      if (p < 0) { if (t > t0) t0 = t } else { if (t < t1) t1 = t }
      if (t0 > t1) return false
    }
  }
  return true
}

// Find where the ray from symbol center (ox, oy) in direction (nx, ny) enters the bbox.
// Returns the endpoint for the leader line (stopping just outside the text bbox).
function computeLeaderEnd(ox, oy, nx, ny, bbox) {
  let tBest = Infinity
  if (Math.abs(nx) > 1e-6) {
    for (const ex of [bbox.x1, bbox.x2]) {
      const t = (ex - ox) / nx
      if (t > SYMBOL_RADIUS) {
        const py = oy + t * ny
        if (py >= bbox.y1 && py <= bbox.y2 && t < tBest) tBest = t
      }
    }
  }
  if (Math.abs(ny) > 1e-6) {
    for (const ey of [bbox.y1, bbox.y2]) {
      const t = (ey - oy) / ny
      if (t > SYMBOL_RADIUS) {
        const px = ox + t * nx
        if (px >= bbox.x1 && px <= bbox.x2 && t < tBest) tBest = t
      }
    }
  }
  const t = tBest === Infinity ? TEXT_DIST : Math.max(SYMBOL_RADIUS + 1, tBest - LEADER_GAP)
  return { x: ox + t * nx, y: oy + t * ny }
}

/**
 * Draw CATCC datablocks for all visible contacts.
 *
 * Label placement uses 8-direction candidate testing (NE preferred).
 * Candidates are scored against placed labels, contact symbols, and the
 * marshal/approach radial line. Leaders are drawn to the bbox near-edge
 * so they never enter the text area.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} view            { centerLat, centerLng, pixelsPerNm, width, height }
 * @param {object} units           { [id]: unit }
 * @param {object} correlations    { [unitId]: sideNumber string }
 * @param {number} brite           0–100
 * @param {number|null} marshalBearing  magnetic bearing of the marshal/approach radial (degrees)
 */
export function drawCatccDatablocks(ctx, view, units, correlations, brite = 80, marshalBearing = null) {
  const alpha = Math.max(0, Math.min(1, brite / 100))
  if (alpha <= 0) return

  const { width, height, pixelsPerNm } = view

  // ── Radial line segment (marshal + approach corridor, same bearing) ────────
  // Both lines start at scope center; use the longer one (120nm marshal radial).
  const radials = []
  if (marshalBearing != null) {
    const cx  = width  / 2
    const cy  = height / 2
    const rad = marshalBearing * Math.PI / 180
    radials.push({
      x0: cx, y0: cy,
      x1: cx + Math.sin(rad) * 120 * pixelsPerNm,
      y1: cy - Math.cos(rad) * 120 * pixelsPerNm,
    })
  }

  ctx.save()
  ctx.font         = '10px "Roboto Mono", monospace'
  ctx.textBaseline = 'alphabetic'

  // ── Pass 1: collect visible contacts and measure text ─────────────────────
  const contacts = []
  for (const [id, unit] of Object.entries(units)) {
    const pos = unit.position
    if (!pos) continue
    const { x, y } = latLngToCanvas(pos.lat, pos.lng, view)
    if (x < -100 || x > width + 100 || y < -100 || y > height + 100) continue
    const line1 = correlations[String(id)] ?? 'XXX'
    const line2 = `${fmtAlt(pos.alt)} ${fmtGs(unit.speed)}`
    contacts.push({ x, y, line1, line2, w1: ctx.measureText(line1).width, w2: ctx.measureText(line2).width })
  }

  // Symbol bboxes — fixed obstacles
  const symbolBBoxes = contacts.map(({ x, y }) => ({
    x1: x - SYMBOL_RADIUS - PADDING, y1: y - SYMBOL_RADIUS - PADDING,
    x2: x + SYMBOL_RADIUS + PADDING, y2: y + SYMBOL_RADIUS + PADDING,
  }))

  // ── Pass 2: place labels ──────────────────────────────────────────────────
  const placedLabels = []

  for (let i = 0; i < contacts.length; i++) {
    const { x, y, w1, w2 } = contacts[i]

    const obstacles = [
      ...symbolBBoxes.filter((_, j) => j !== i),
      ...placedLabels,
    ]

    let bestBBox    = null
    let bestScore   = Infinity

    for (const angle of CANDIDATE_ANGLES) {
      const lx1  = x + Math.cos(angle) * TEXT_DIST
      const ly1  = y + Math.sin(angle) * TEXT_DIST
      const bbox = labelBBox(lx1, ly1, angle, w1, w2)

      let score = obstacles.reduce((sum, o) => sum + overlapArea(bbox, o), 0)

      for (const r of radials) {
        if (segmentHitsBBox(r.x0, r.y0, r.x1, r.y1, bbox)) score += RADIAL_PENALTY
      }

      if (score < bestScore) {
        bestScore = score
        bestBBox  = bbox
      }
      if (score === 0) break
    }

    placedLabels.push(bestBBox)
    contacts[i].bbox = bestBBox
  }

  // ── Pass 3: draw leaders and text ─────────────────────────────────────────
  const gold = `rgba(255,215,0,${alpha})`

  for (const { x, y, line1, line2, bbox } of contacts) {
    if (!bbox) continue

    const dx  = bbox.lx1 - x
    const dy  = bbox.ly1 - y
    const len = Math.sqrt(dx * dx + dy * dy) || 1
    const nx  = dx / len
    const ny  = dy / len
    const lx0 = x + nx * SYMBOL_RADIUS
    const ly0 = y + ny * SYMBOL_RADIUS
    const end = computeLeaderEnd(x, y, nx, ny, bbox)

    ctx.strokeStyle = gold
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.moveTo(lx0, ly0)
    ctx.lineTo(end.x, end.y)
    ctx.stroke()

    ctx.fillStyle = gold
    ctx.textAlign = bbox.align
    ctx.fillText(line1, bbox.textX, bbox.ly1)
    ctx.fillText(line2, bbox.textX, bbox.ly1 + LINE_HEIGHT)
  }

  ctx.restore()
}
