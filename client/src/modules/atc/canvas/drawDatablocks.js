import { latLngToCanvas } from './projection.js'
import { resolveCallsign } from '../../../utils/callsign.js'

const M_PER_S_TO_KNOTS = 1.94384
const METERS_TO_FEET   = 3.28084

/** Format altitude: metres → feet → hundreds, 3-digit padded (e.g. "055") */
function fmtAlt(metres) {
  if (metres == null) return '---'
  const hundreds = Math.round(metres * METERS_TO_FEET / 100)
  return String(hundreds).padStart(3, '0')
}

/** Format speed: m/s → knots / 10, 2-digit (e.g. "18") */
function fmtSpd(mps) {
  if (mps == null) return '--'
  const kt = Math.round(mps * M_PER_S_TO_KNOTS / 10)
  return String(Math.min(kt, 99)).padStart(2, '0')
}

/**
 * Layer 3 — datablocks and leader lines.
 *
 * FDB (owned):            white,  2 lines: CALLSIGN / ALT  SPD
 * PDB (tracked by other): green,  1 line:  CALLSIGN  ALT
 * LDB (untracked):        green,  1 line:  ALT  SPD
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} view         { centerLat, centerLng, pixelsPerNm, width, height }
 * @param {Object} units        filtered visible units { [id]: unit }
 * @param {Object} ownership    { [unitId]: controllerId }
 * @param {string} myPosition   this controller's controllerId
 * @param {object} visual       profile.visual
 */
export function drawDatablocks(ctx, view, units, ownership, myPosition, visual) {
  const width  = ctx.canvas.width
  const height = ctx.canvas.height
  const { colors, symbol, dataBlock } = visual

  const leaderLen   = dataBlock.leaderLength  ?? 40
  const leaderAngle = (dataBlock.leaderAngleDeg ?? -45) * Math.PI / 180
  const lh          = dataBlock.lineHeight    ?? 12
  const symbolRadius = (symbol.diameter ?? 13) / 2

  const ldx = Math.cos(leaderAngle) * leaderLen
  const ldy = Math.sin(leaderAngle) * leaderLen

  ctx.clearRect(0, 0, width, height)
  ctx.font      = dataBlock.font ?? '500 10px "Roboto Mono", monospace'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'

  for (const [id, unit] of Object.entries(units)) {
    const pos = unit.position
    if (!pos) continue

    const { x, y } = latLngToCanvas(pos.lat, pos.lng, view)
    if (x < -100 || x > width + 100 || y < -100 || y > height + 100) continue

    const owner    = ownership[String(id)]
    const isOwned   = owner === myPosition
    const isTracked = owner && owner !== myPosition

    const alt = fmtAlt(pos.alt)
    const spd = fmtSpd(unit.speed)
    const cs  = resolveCallsign(unit)

    let lines, color
    if (isOwned) {
      lines = [ cs, `${alt}  ${spd}` ]
      color = colors.fdbText
    } else if (isTracked) {
      lines = [ `${cs}  ${alt}` ]
      color = colors.pdbText
    } else {
      lines = [ `${alt}  ${spd}` ]
      color = colors.ldbText
    }

    // Leader line — from symbol edge to block anchor
    const lx0 = x + Math.cos(leaderAngle) * symbolRadius
    const ly0 = y + Math.sin(leaderAngle) * symbolRadius
    const lx1 = x + ldx
    const ly1 = y + ldy

    ctx.strokeStyle = colors.leaderLine
    ctx.lineWidth   = 0.8
    ctx.beginPath()
    ctx.moveTo(lx0, ly0)
    ctx.lineTo(lx1, ly1)
    ctx.stroke()

    // Data block text
    ctx.fillStyle = color
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], lx1 + 2, ly1 + i * lh)
    }
  }
}
