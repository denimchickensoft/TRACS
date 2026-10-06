// Shared datablock leader-direction / collision-avoidance placement, used by
// STARS, CATCC and ABM behind each module's .dbca toggle.
//
// Pure geometry — callers measure text themselves (ctx.measureText for
// canvas renderers, a monospace char-count estimate for STARS' SVG
// datablocks) and pass widths in; this module never touches a canvas.
//
// Every contact carries two directions, resolved by the calling module:
//   unitAngleDeg    — the track's individually-set leader direction (numpad
//                     key + click/slew), or null
//   generalAngleDeg — the module-wide LDR DIR (always set; the module falls
//                     back to its own default)
//
// Placement order:
//   1. Contacts with a unitAngleDeg are placed at exactly that angle, first,
//      unconditionally — an operator-set direction always wins.
//   2. Every other contact tries the 8 directions, nearest to its general
//      direction first, and takes the one with the best conflict vector,
//      compared rank by rank (a lower rank only ever breaks a tie above it):
//        0. extraObstacles hit (e.g. CATCC's marshal radial)
//        1. datablock overlaps another datablock (overlap area)
//        2. leader crosses another leader
//        3. leader passes through another datablock
//        4. leader passes through another contact's symbol
//        5. datablock covers another contact's leader or symbol
//        6. angular distance from the general direction (45° steps)
//        7. points away from nearby contacts
//      An uncontested contact therefore always sits at its general direction.
//   3. One refinement pass re-places every contact from step 2 against every
//      other contact's final position, so the first contact placed isn't
//      blind to the ones placed after it.
//
// With avoid: false each contact is simply placed at unitAngleDeg ??
// generalAngleDeg, reusing the same geometry.
//
// Geometry matches each module's non-dbca leader: the line runs from the
// symbol edge to a tip leaderLen px from the contact center, and the text
// starts TEXT_GAP past the tip — right-aligned for S/SW/W/NW, left-aligned
// otherwise — so toggling .dbca never changes leader length.

const COMPASS_ANGLES_DEG = [-90, -45, 0, 45, 90, 135, 180, -135]

const DEFAULT_PADDING = 2
const TEXT_GAP        = 2 // px between the leader tip and the text, same as each module's non-dbca path

// Signed angular difference in (-π, π], robust to callers mixing angle
// ranges (e.g. DIR_TO_ANGLE's 0–360° vs the -135..180° compass set).
function angleDiff(a, b) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b))
}

// Axis-aligned bbox for an N-line label whose first line's baseline is at
// (textX, ly1), left- or right-aligned on textX.
function computeBBox(textX, ly1, align, lineWidths, { lineHeight, ascent, descent, padding }) {
  const width = Math.max(...lineWidths)
  const left  = align === 'right' ? textX - width : textX
  const blockHeight = ascent + (lineWidths.length - 1) * lineHeight + descent
  return {
    x1: left - padding,
    y1: ly1 - ascent - padding,
    x2: left + width + padding,
    y2: ly1 - ascent + blockHeight + padding,
    textX,
    align,
    ly1,
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

function leaderHitsBBox(l, box) {
  return segmentHitsBBox(l.start.x, l.start.y, l.end.x, l.end.y, box)
}

// Proper segment–segment intersection (shared endpoints / collinear touching
// don't count — two leaders can't share an endpoint anyway).
function segmentsIntersect(a, b) {
  const cross = (ox, oy, px, py, qx, qy) => (px - ox) * (qy - oy) - (py - oy) * (qx - ox)
  const d1 = cross(b.start.x, b.start.y, b.end.x, b.end.y, a.start.x, a.start.y)
  const d2 = cross(b.start.x, b.start.y, b.end.x, b.end.y, a.end.x,   a.end.y)
  const d3 = cross(a.start.x, a.start.y, a.end.x, a.end.y, b.start.x, b.start.y)
  const d4 = cross(a.start.x, a.start.y, a.end.x, a.end.y, b.end.x,   b.end.y)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

function compareVectors(a, b) {
  for (let k = 0; k < a.length; k++) {
    if (a[k] !== b[k]) return a[k] - b[k]
  }
  return 0
}

/**
 * @param {Array} contacts  [{ id, x, y, lineWidths: number[], unitAngleDeg: number|null, generalAngleDeg: number }]
 * @param {object} opts
 * @param {boolean} [opts.avoid]  false → every contact at unitAngleDeg ?? generalAngleDeg, no avoidance
 * @param {number} opts.symbolRadius
 * @param {number} opts.leaderLen
 * @param {number} opts.lineHeight
 * @param {number} opts.ascent
 * @param {number} opts.descent
 * @param {number} [opts.padding]
 * @param {'baseline'|'center'} [opts.textAnchor]  'baseline': first line's baseline on the
 *   leader tip (STARS); 'center': multi-line blocks shifted up half a line (ABM/CATCC)
 * @param {Array}  [opts.extraObstacles]     [{ x0, y0, x1, y1, penalty }] — e.g. CATCC's marshal radial
 * @param {Function} [opts.filterCandidates] (contact, candidateAnglesRad) => candidateAnglesRad | null
 * @returns {Object} { [id]: { angleDeg, bbox, leaderStart: {x,y}, leaderEnd: {x,y} } }
 */
export function placeDatablocks(contacts, opts) {
  const {
    avoid        = true,
    symbolRadius,
    leaderLen,
    lineHeight,
    ascent,
    descent,
    padding      = DEFAULT_PADDING,
    textAnchor   = 'baseline',
    extraObstacles   = [],
    filterCandidates = null,
  } = opts

  const tipDist  = Math.max(leaderLen, symbolRadius)
  const bboxOpts = { lineHeight, ascent, descent, padding }

  function placeAt(contact, angle) {
    const nx   = Math.cos(angle)
    const ny   = Math.sin(angle)
    const tipX = contact.x + nx * tipDist
    const tipY = contact.y + ny * tipDist
    // Matches RIGHT_ALIGN_ANGLES (S/SW/W/NW): straight down counts as right.
    const align = nx < -0.1 || (Math.abs(nx) <= 0.1 && ny > 0) ? 'right' : 'left'
    const textX = tipX + (align === 'right' ? -TEXT_GAP : TEXT_GAP)
    const ly1   = textAnchor === 'center' && contact.lineWidths.length > 1
      ? tipY - Math.round(lineHeight / 2)
      : tipY
    return {
      angle,
      bbox: computeBBox(textX, ly1, align, contact.lineWidths, bboxOpts),
      leader: {
        start: { x: contact.x + nx * symbolRadius, y: contact.y + ny * symbolRadius },
        end:   { x: tipX, y: tipY },
      },
    }
  }

  const placed = new Array(contacts.length).fill(null)

  if (!avoid) {
    contacts.forEach((c, i) => {
      placed[i] = placeAt(c, (c.unitAngleDeg ?? c.generalAngleDeg) * Math.PI / 180)
    })
    return toResult(contacts, placed)
  }

  const symbolBBoxes = contacts.map(({ x, y }) => ({
    x1: x - symbolRadius - padding, y1: y - symbolRadius - padding,
    x2: x + symbolRadius + padding, y2: y + symbolRadius + padding,
  }))

  // Contacts close enough for their side to matter in the away-from-neighbour
  // tiebreak — roughly one leader + one datablock away.
  const maxWidth   = Math.max(0, ...contacts.map((c) => Math.max(...c.lineWidths)))
  const nearRadius = tipDist + maxWidth + lineHeight * 2
  const neighbours = buildNeighbours(contacts, footprintReach(contacts, maxWidth, { symbolRadius, leaderLen, lineHeight, ascent, descent, padding }), nearRadius)

  function conflictVector(i, cand, generalRad) {
    const contact = contacts[i]
    const { bbox, leader } = cand
    let extra = 0, dbOverDb = 0, ldrXLdr = 0, ldrThruDb = 0, ldrThruSym = 0, dbOnOther = 0, away = 0

    for (const ob of extraObstacles) {
      if (segmentHitsBBox(ob.x0, ob.y0, ob.x1, ob.y1, bbox)) extra += (ob.penalty ?? 1)
    }

    for (const j of neighbours[i]) {
      const sym = symbolBBoxes[j]
      if (leaderHitsBBox(leader, sym)) ldrThruSym++
      if (overlapArea(bbox, sym) > 0)  dbOnOther++

      const other = placed[j]
      if (other) {
        dbOverDb += overlapArea(bbox, other.bbox)
        if (segmentsIntersect(leader, other.leader)) ldrXLdr++
        if (leaderHitsBBox(leader, other.bbox))      ldrThruDb++
        if (leaderHitsBBox(other.leader, bbox))      dbOnOther++
      }

      const dx = contacts[j].x - contact.x
      const dy = contacts[j].y - contact.y
      const d  = Math.hypot(dx, dy)
      if (d > 0 && d < nearRadius) {
        away += Math.cos(cand.angle - Math.atan2(dy, dx)) * (1 - d / nearRadius)
      }
    }

    const steps = Math.round(Math.abs(angleDiff(cand.angle, generalRad)) / (Math.PI / 4))
    return [extra, dbOverDb, ldrXLdr, ldrThruDb, ldrThruSym, dbOnOther, steps, away]
  }

  function placeBest(i) {
    const contact    = contacts[i]
    const generalRad = contact.generalAngleDeg * Math.PI / 180

    let candidates = COMPASS_ANGLES_DEG
      .map((d) => d * Math.PI / 180)
      .sort((a, b) => Math.abs(angleDiff(a, generalRad)) - Math.abs(angleDiff(b, generalRad)))
    if (filterCandidates) {
      const restricted = filterCandidates(contact, candidates)
      if (restricted && restricted.length > 0) candidates = restricted
    }

    let best = null, bestVec = null
    for (const angle of candidates) {
      const cand = placeAt(contact, angle)
      const vec  = conflictVector(i, cand, generalRad)
      if (!best || compareVectors(vec, bestVec) < 0) {
        best = cand
        bestVec = vec
      }
    }
    return best
  }

  const free = []
  contacts.forEach((c, i) => {
    if (c.unitAngleDeg != null) placed[i] = placeAt(c, c.unitAngleDeg * Math.PI / 180)
    else free.push(i)
  })

  for (const i of free) placed[i] = placeBest(i)

  // Refinement — each free contact re-placed against everyone else's final
  // position (its own current placement excluded while it's re-scored).
  for (const i of free) {
    placed[i] = null
    placed[i] = placeBest(i)
  }

  return toResult(contacts, placed)
}

// Furthest any part of a contact's own footprint (symbol, leader, datablock
// at any of the 8 angles) can sit from its center, per axis, plus 1px slack
// for the rounding in placeAt/computeBBox.
function footprintReach(contacts, maxWidth, { symbolRadius, leaderLen, lineHeight, ascent, descent, padding }) {
  const tipDist  = Math.max(leaderLen, symbolRadius)
  const maxLines = Math.max(1, ...contacts.map((c) => c.lineWidths.length))
  const reachX = tipDist + TEXT_GAP + maxWidth + padding
  const reachY = tipDist + lineHeight + ascent + descent + (maxLines - 1) * lineHeight + padding
  return Math.max(reachX, reachY) + 1
}

// For each contact, the indices (ascending, self excluded) of every contact
// that can affect its conflict vector: one whose footprint can touch its
// footprint (centers within 2 * reach on both axes) or that counts toward
// the away-from-neighbour tiebreak (within nearRadius). Anything further
// scores exactly 0 on every rank, so skipping it leaves placement unchanged,
// and ascending order keeps the floating-point sums in the same order as a
// full scan. Bucketed into a grid so this is ~O(n) instead of O(n²).
function buildNeighbours(contacts, reach, nearRadius) {
  const range = Math.max(2 * reach, nearRadius)
  const cellOf = (v) => Math.floor(v / range)
  const grid = new Map()
  contacts.forEach((c, i) => {
    const key = `${cellOf(c.x)},${cellOf(c.y)}`
    let cell = grid.get(key)
    if (!cell) grid.set(key, cell = [])
    cell.push(i)
  })
  return contacts.map((c, i) => {
    const cx = cellOf(c.x), cy = cellOf(c.y)
    const out = []
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (const j of grid.get(`${gx},${gy}`) ?? []) {
          if (j !== i && Math.abs(contacts[j].x - c.x) <= range && Math.abs(contacts[j].y - c.y) <= range) out.push(j)
        }
      }
    }
    return out.sort((a, b) => a - b)
  })
}

function toResult(contacts, placed) {
  const result = {}
  contacts.forEach((c, i) => {
    const p = placed[i]
    result[c.id] = {
      angleDeg:    p.angle * 180 / Math.PI,
      bbox:        p.bbox,
      leaderStart: p.leader.start,
      leaderEnd:   p.leader.end,
    }
  })
  return result
}
