import { latLngToCanvas } from '../../atc/stars/canvas/projection.js'
import { DIR_TO_ANGLE }   from '../../atc/stars/constants.js'
import { placeDatablocks } from '../../../utils/datablockPlacement.js'

const M_TO_FT  = 3.28084
const MS_TO_KT = 1.94384

const SYMBOL_RADIUS  = 5     // px — matches circle radius in drawCatccContacts
const LEADER_LEN     = 16    // px default — long enough that bbox near-edge clears symbol for all angles
const LINE_HEIGHT    = 11    // px between text lines
const ASCENT         = 9     // approx ascent for 10px monospace
const DESCENT        = 2     // approx descent
const PADDING        = 2     // extra clearance around each bbox
const RADIAL_PENALTY = 1e6   // score penalty for hitting a radial line
const OFF_MODE_ANGLE = -45   // NE — CATCC's fixed default when .dbca is off and no preference is set

// Preference bonuses: subtracted from the chosen direction's collision score.
// Unit-level wins against any label overlap but still yields to the radial (1e6).
// Global-level yields to roughly one full label worth of overlap (~960 px²).
const UNIT_DIR_BONUS   = 9e5
const GLOBAL_DIR_BONUS = 400

function fmtAlt(metres) {
  if (metres == null) return '---'
  return String(Math.round((metres * M_TO_FT) / 100)).padStart(3, '0')
}

function fmtGs(mps) {
  if (mps == null) return '---'
  return String(Math.round(mps * MS_TO_KT))
}

/**
 * Draw CATCC datablocks for all visible contacts.
 *
 * When dbca is true, label placement uses 8-direction candidate testing
 * (NE preferred), scored against placed labels, contact symbols, and the
 * marshal/approach radial line (see utils/datablockPlacement.js). When
 * false, each contact is placed at its individually-set direction, else the
 * module default direction, else NE — no avoidance, matching pre-.dbca
 * behavior. Leaders are drawn to the bbox near-edge so they never enter the
 * text area.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} view            { centerLat, centerLng, pixelsPerNm, width, height }
 * @param {object} units           { [id]: unit }
 * @param {object} correlations    { [unitId]: sideNumber string }
 * @param {number} brite           0–100
 * @param {number|null} marshalBearing  magnetic bearing of the marshal/approach radial (degrees)
 * @param {boolean} dbca           datablock collision avoidance on/off
 */
export function drawCatccDatablocks(ctx, view, units, correlations, brite = 80, marshalBearing = null, leaderDirs = {}, globalLeaderDir = null, blinkingUids = new Set(), blinkPhase = false, ownership = {}, myControllerId = null, leaderLen = LEADER_LEN, dbca = true) {
  const alpha = Math.max(0, Math.min(1, brite / 100))
  if (alpha <= 0) return

  const { width, height, pixelsPerNm } = view
  const cx = width  / 2
  const cy = height / 2

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
    const unitDir = leaderDirs[String(id)] ?? null
    const prefAngleDeg = unitDir != null ? DIR_TO_ANGLE[unitDir]
                        : globalLeaderDir != null ? DIR_TO_ANGLE[globalLeaderDir]
                        : null
    const prefTier = unitDir != null ? 'unit' : globalLeaderDir != null ? 'global' : null
    contacts.push({
      id, x, y, line1, line2,
      lineWidths: [ctx.measureText(line1).width, ctx.measureText(line2).width],
      prefAngleDeg, prefTier,
    })
  }

  // ── Pass 2: place labels ──────────────────────────────────────────────────
  const placementOpts = {
    symbolRadius: SYMBOL_RADIUS,
    leaderLen,
    lineHeight: LINE_HEIGHT,
    ascent: ASCENT,
    descent: DESCENT,
    padding: PADDING,
    unitBonus: UNIT_DIR_BONUS,
    globalBonus: GLOBAL_DIR_BONUS,
  }

  let placements
  if (dbca) {
    // Radial line segment (marshal + approach corridor, same bearing) — both
    // lines start at scope center; use the longer one (50nm marshal radial).
    const extraObstacles = []
    if (marshalBearing != null) {
      const rad = marshalBearing * Math.PI / 180
      extraObstacles.push({
        x0: cx, y0: cy,
        x1: cx + Math.sin(rad) * 50 * pixelsPerNm,
        y1: cy - Math.cos(rad) * 50 * pixelsPerNm,
        penalty: RADIAL_PENALTY,
      })
    }

    // For contacts within 1 NM cross-track of the final bearing, restrict
    // candidates to the right side of the approach track (looking inbound).
    const fbRad = marshalBearing != null
      ? ((marshalBearing + 180) % 360) * Math.PI / 180
      : null
    const filterCandidates = fbRad == null ? null : (contact, candidatesRad) => {
      const crossTrackNm = ((contact.x - cx) * Math.cos(fbRad) + (contact.y - cy) * Math.sin(fbRad)) / pixelsPerNm
      if (Math.abs(crossTrackNm) >= 1.0) return candidatesRad
      const restricted = candidatesRad.filter((a) => Math.cos(a - fbRad) > 0)
      return restricted.length > 0 ? restricted : candidatesRad
    }

    placements = placeDatablocks(contacts, { ...placementOpts, extraObstacles, filterCandidates })
  } else {
    // No cross-contact avoidance — each contact placed independently at its
    // individually-set direction, else the module default, else NE.
    placements = {}
    for (const contact of contacts) {
      Object.assign(placements, placeDatablocks([contact], {
        ...placementOpts,
        candidateAnglesDeg: [contact.prefAngleDeg ?? OFF_MODE_ANGLE],
      }))
    }
  }

  // ── Pass 3: draw leaders and text ─────────────────────────────────────────
  for (const { id, line1, line2 } of contacts) {
    const placement = placements[id]
    if (!placement) continue
    const { bbox, leaderStart, leaderEnd } = placement

    const isBlinking  = blinkingUids.has(String(id))
    const isMine      = !!myControllerId && ownership[String(id)] === myControllerId
    const contactAlpha = isBlinking
      ? (blinkPhase ? alpha : alpha * 0.60)
      : isMine ? alpha : alpha * 0.60
    const gold = `rgba(255,215,0,${contactAlpha})`

    ctx.strokeStyle = gold
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.moveTo(leaderStart.x, leaderStart.y)
    ctx.lineTo(leaderEnd.x, leaderEnd.y)
    ctx.stroke()

    ctx.fillStyle = gold
    ctx.textAlign = bbox.align
    ctx.fillText(line1, bbox.textX, bbox.ly1)
    ctx.fillText(line2, bbox.textX, bbox.ly1 + LINE_HEIGHT)
  }

  ctx.restore()
}
