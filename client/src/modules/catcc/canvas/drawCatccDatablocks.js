import { latLngToCanvas } from '../../../utils/projection.js'
import { DIR_TO_ANGLE, ALERT_BRIGHT, ALERT_DIM } from '../../../utils/scopeConstants.js'
import { placeDatablocks } from '../../../utils/datablockPlacement.js'
import { altHundreds, speedFromMs } from '../../../utils/units.js'


const SYMBOL_RADIUS  = 5     // px — matches circle radius in drawCatccContacts
const LEADER_LEN     = 20    // px default (.LL 2), measured from contact center
const PADDING        = 2     // extra clearance around each bbox
const DEFAULT_ANGLE  = -45   // NE — CATCC's general leader direction when no .LD is set

// sys: the CATCC unit system (view.unitSystem) — hundreds of ft/m, whole
// kt/kmh.
function fmtAlt(metres, sys) {
  if (metres == null) return '---'
  return altHundreds(metres, sys)
}

function fmtGs(mps, sys) {
  if (mps == null) return '---'
  return String(Math.round(speedFromMs(mps, sys)))
}

/**
 * Draw CATCC datablocks for all visible contacts.
 *
 * When dbca is true, a contact with an individually-set direction keeps it;
 * every other contact starts from the general direction (.LD, else NE) and
 * moves only to avoid other datablocks/leaders/symbols and the
 * marshal/approach radial line (see utils/datablockPlacement.js). When
 * false, each contact is placed at its individually-set direction, else the
 * general direction — no avoidance. Leaders run from the symbol edge to a
 * tip leaderLen px from the contact, with the text just past the tip.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} view            { centerLat, centerLng, pixelsPerNm, width, height }
 * @param {object} units           { [id]: unit }
 * @param {object} correlations    { [unitId]: sideNumber string } — revealed (BCN+callsign matched, or old-model non-srsCapable)
 * @param {object} pendingCodes    { [unitId]: squawk string } — srsCapable, squawking, not yet BCN-matched (reduced info instead of 'XXX')
 * @param {number} brite           0–100
 * @param {number|null} marshalBearing  magnetic bearing of the marshal/approach radial (degrees)
 * @param {boolean} dbca           datablock collision avoidance on/off
 * @param {number}  dbSize         0–5 char size index (see .dbsize)
 * @param {object}  spcAlerts      { [unitId]: { code, acked } } — emergency squawk tag shown above line 1
 */
export function drawCatccDatablocks(ctx, view, units, correlations, pendingCodes = {}, brite = 80, marshalBearing = null, leaderDirs = {}, globalLeaderDir = null, blinkingUids = new Set(), blinkPhase = false, ownership = {}, myControllerId = null, leaderLen = LEADER_LEN, dbca = true, dbSize = 2, spcAlerts = {}) {
  const alpha = Math.max(0, Math.min(1, brite / 100))
  if (alpha <= 0) return

  const { width, height, pixelsPerNm } = view
  const cx = width  / 2
  const cy = height / 2

  const fontPx     = 8 + dbSize * 2
  const lineHeight = Math.round(fontPx * 1.1)
  const ascent     = Math.round(fontPx * 0.9)
  const descent    = Math.round(fontPx * 0.2)

  ctx.save()
  ctx.font         = `${fontPx}px "Roboto Mono", monospace`
  ctx.textBaseline = 'alphabetic'

  const generalAngleDeg = DIR_TO_ANGLE[globalLeaderDir] ?? DEFAULT_ANGLE

  // ── Pass 1: collect visible contacts and measure text ─────────────────────
  const contacts = []
  for (const [id, unit] of Object.entries(units)) {
    const pos = unit.position
    if (!pos) continue
    const { x, y } = latLngToCanvas(pos.lat, pos.lng, view)
    if (x < -100 || x > width + 100 || y < -100 || y > height + 100) continue
    const line1 = correlations[String(id)] ?? pendingCodes[String(id)] ?? 'XXX'
    const line2 = `${fmtAlt(pos.alt, view.unitSystem)} ${fmtGs(unit.speed, view.unitSystem)}`
    // Emergency squawk: an extra line above, measured so placement keeps it clear
    const spc   = spcAlerts[String(id)] ?? null
    const lines = spc ? [spc.code, line1, line2] : [line1, line2]
    contacts.push({
      id, x, y, lines, spc,
      lineWidths: lines.map((t) => ctx.measureText(t).width),
      unitAngleDeg: DIR_TO_ANGLE[leaderDirs[String(id)]] ?? null,
      generalAngleDeg,
    })
  }

  // ── Pass 2: place labels ──────────────────────────────────────────────────
  const placementOpts = {
    symbolRadius: SYMBOL_RADIUS,
    leaderLen,
    lineHeight,
    ascent,
    descent,
    padding: PADDING,
    textAnchor: 'center',
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
    placements = placeDatablocks(contacts, { ...placementOpts, avoid: false })
  }

  // ── Pass 3: draw leaders and text ─────────────────────────────────────────
  for (const { id, lines, spc } of contacts) {
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

    ctx.textAlign = bbox.align
    for (let i = 0; i < lines.length; i++) {
      // The tag is red, blinking until acknowledged
      ctx.fillStyle = spc && i === 0
        ? (spc.acked || blinkPhase ? ALERT_BRIGHT : ALERT_DIM)
        : gold
      ctx.fillText(lines[i], bbox.textX, bbox.ly1 + i * lineHeight)
    }
  }

  ctx.restore()
}
