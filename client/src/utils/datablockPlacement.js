// Shared datablock leader-direction / collision-avoidance placement, used by
// CATCC, with ATC/STARS and ABM able to opt into the same algorithm behind their own .dbca toggles.
//
// Pure geometry — callers measure text themselves (ctx.measureText for
// canvas renderers, a monospace char-count estimate for STARS' SVG
// datablocks) and pass widths in; this module never touches a canvas.
//
// Per contact, tries a fixed set of candidate leader directions and scores
// each by summed pixel-overlap against every other contact's symbol and
// every label already placed earlier in the same pass (labels accumulate as
// obstacles, so processing order matters — Object.entries order today).
// Priority order:
//   1. extraObstacles (e.g. CATCC's marshal radial) — large penalty, a near-hard veto
//   2. prefTier 'unit'   — individually-set (numpad) leader direction — strong bias
//   3. prefTier 'global' — module-wide default leader direction        — soft tiebreaker
//   4. no preference — pure overlap-minimization
//
// "Off" mode (a module's .dbca disabled) is just this same function called
// with a single-element candidateAnglesDeg (the resolved preferred/default
// angle) — with one candidate, obstacle scoring can't change the outcome,
// so it degenerates to today's fixed-angle behavior for free while still
// reusing the same bbox/leader-end math.

export const DEFAULT_CANDIDATE_ANGLES_DEG = [-45, -135, -90, 0, 45, 180, 90, 135]

const DEFAULT_UNIT_BONUS   = 9e5
const DEFAULT_GLOBAL_BONUS = 400
const DEFAULT_PADDING      = 2
const DEFAULT_LEADER_GAP   = 2

// Signed angular difference in (-π, π], robust to callers mixing angle
// ranges (e.g. DIR_TO_ANGLE's 0–360° vs this module's -45..180° candidates).
function angleDiff(a, b) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b))
}

// Axis-aligned bbox for an N-line label anchored at the leader tip (lx1,ly1
// is the first line's baseline). Text alignment flips so the block always
// extends away from the symbol.
function computeBBox(lx1, ly1, angleRad, lineWidths, { lineHeight, ascent, descent, padding }) {
  const cosA  = Math.cos(angleRad)
  const width = Math.max(...lineWidths)
  let left
  if      (cosA >  0.1) left = lx1
  else if (cosA < -0.1) left = lx1 - width
  else                  left = lx1 - width / 2
  const blockHeight = ascent + (lineWidths.length - 1) * lineHeight + descent
  return {
    x1: left - padding,
    y1: ly1 - ascent - padding,
    x2: left + width + padding,
    y2: ly1 - ascent + blockHeight + padding,
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

// Where the ray from the symbol center (ox,oy) in direction (nx,ny) enters
// the bbox — the leader line stops just outside the text (leaderGap) rather
// than terminating at the anchor corner or poking into the text.
function computeLeaderEnd(ox, oy, nx, ny, bbox, textDist, symbolRadius, leaderGap) {
  let tBest = Infinity
  if (Math.abs(nx) > 1e-6) {
    for (const ex of [bbox.x1, bbox.x2]) {
      const t = (ex - ox) / nx
      if (t > symbolRadius) {
        const py = oy + t * ny
        if (py >= bbox.y1 && py <= bbox.y2 && t < tBest) tBest = t
      }
    }
  }
  if (Math.abs(ny) > 1e-6) {
    for (const ey of [bbox.y1, bbox.y2]) {
      const t = (ey - oy) / ny
      if (t > symbolRadius) {
        const px = ox + t * nx
        if (px >= bbox.x1 && px <= bbox.x2 && t < tBest) tBest = t
      }
    }
  }
  const t = tBest === Infinity ? textDist : Math.max(symbolRadius + 1, tBest - leaderGap)
  return { x: ox + t * nx, y: oy + t * ny }
}

/**
 * @param {Array} contacts  [{ id, x, y, lineWidths: number[], prefAngleDeg: number|null, prefTier: 'unit'|'global'|null }]
 * @param {object} opts
 * @param {number[]} [opts.candidateAnglesDeg]  candidate leader directions, degrees, in preference order.
 *   Pass a single-element array to get today's fixed-angle (no-avoidance) behavior for free.
 * @param {number} opts.symbolRadius
 * @param {number} opts.leaderLen
 * @param {number} opts.lineHeight
 * @param {number} opts.ascent
 * @param {number} opts.descent
 * @param {number} [opts.padding]
 * @param {number} [opts.unitBonus]    score bonus for matching a per-track preferred angle
 * @param {number} [opts.globalBonus]  score bonus for matching the module-wide default angle
 * @param {number} [opts.leaderGap]
 * @param {Array}  [opts.extraObstacles]     [{ x0, y0, x1, y1, penalty }] — e.g. CATCC's marshal radial
 * @param {Function} [opts.filterCandidates] (contact, candidateAnglesRad) => candidateAnglesRad | null
 * @returns {Object} { [id]: { angleDeg, bbox, leaderStart: {x,y}, leaderEnd: {x,y} } }
 */
export function placeDatablocks(contacts, opts) {
  const {
    candidateAnglesDeg = DEFAULT_CANDIDATE_ANGLES_DEG,
    symbolRadius,
    leaderLen,
    lineHeight,
    ascent,
    descent,
    padding      = DEFAULT_PADDING,
    unitBonus    = DEFAULT_UNIT_BONUS,
    globalBonus  = DEFAULT_GLOBAL_BONUS,
    leaderGap    = DEFAULT_LEADER_GAP,
    extraObstacles   = [],
    filterCandidates = null,
  } = opts

  const textDist = symbolRadius + leaderLen
  const allCandidatesRad = candidateAnglesDeg.map((d) => d * Math.PI / 180)

  const symbolBBoxes = contacts.map(({ x, y }) => ({
    x1: x - symbolRadius - padding, y1: y - symbolRadius - padding,
    x2: x + symbolRadius + padding, y2: y + symbolRadius + padding,
  }))

  const placedLabels = []
  const result = {}

  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i]
    const prefAngleRad = contact.prefAngleDeg != null ? contact.prefAngleDeg * Math.PI / 180 : null
    const prefBonus = contact.prefTier === 'unit' ? unitBonus
                     : contact.prefTier === 'global' ? globalBonus
                     : 0

    let candidates = allCandidatesRad
    if (filterCandidates) {
      const restricted = filterCandidates(contact, allCandidatesRad)
      if (restricted && restricted.length > 0) candidates = restricted
    }

    const obstacles = [
      ...symbolBBoxes.filter((_, j) => j !== i),
      ...placedLabels,
    ]

    let bestBBox  = null
    let bestAngle = candidates[0]
    let bestScore = Infinity

    for (const angle of candidates) {
      const lx1  = contact.x + Math.cos(angle) * textDist
      const ly1  = contact.y + Math.sin(angle) * textDist
      const bbox = computeBBox(lx1, ly1, angle, contact.lineWidths, { lineHeight, ascent, descent, padding })

      let score = obstacles.reduce((sum, o) => sum + overlapArea(bbox, o), 0)

      for (const ob of extraObstacles) {
        if (segmentHitsBBox(ob.x0, ob.y0, ob.x1, ob.y1, bbox)) score += (ob.penalty ?? 1e6)
      }

      if (prefAngleRad != null && Math.abs(angleDiff(angle, prefAngleRad)) < 0.001) {
        score -= prefBonus
      }

      if (score < bestScore) {
        bestScore = score
        bestBBox  = bbox
        bestAngle = angle
      }
      if (score === 0 && prefAngleRad == null) break  // only short-circuit when no preference is active
    }

    placedLabels.push(bestBBox)

    const dx  = bestBBox.lx1 - contact.x
    const dy  = bestBBox.ly1 - contact.y
    const len = Math.sqrt(dx * dx + dy * dy) || 1
    const nx  = dx / len
    const ny  = dy / len

    result[contact.id] = {
      angleDeg:    bestAngle * 180 / Math.PI,
      bbox:        bestBBox,
      leaderStart: { x: contact.x + nx * symbolRadius, y: contact.y + ny * symbolRadius },
      leaderEnd:   computeLeaderEnd(contact.x, contact.y, nx, ny, bestBBox, textDist, symbolRadius, leaderGap),
    }
  }

  return result
}
