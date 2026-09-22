import { latLngToCanvas }  from '../../../../utils/projection.js'
import { resolveCallsign } from '../../../../utils/callsign.js'
import { destinationPoint } from '../../../../utils/bearing.js'
import { DIR_TO_ANGLE }    from '../../stars/constants.js'
import { hasLiveSquawk }   from '../../../../utils/transponder.js'

const M_PER_S_TO_KT       = 1.94384
const SYMBOL_R             = 7
const RIGHT_ALIGN_ANGLES   = new Set([90, 135, 180, 225])
const UNKNOWN_TARGET_COLOR = '#00e0d0' // teal — real transponder standby (status 0), see transponder-correlation-spec.md §5

export function drawAsdexContacts(ctx, view, units, win, plans, history, centerlines, centerlineVisible, colors, associated = {}, manualTags = {}) {
  ctx.clearRect(0, 0, view.width, view.height)

  // Runway centerlines
  if (centerlineVisible && centerlines?.length) {
    ctx.strokeStyle = '#ffff00'
    ctx.lineWidth   = 1
    ctx.setLineDash([6, 4])
    for (const cl of centerlines) {
      const p1 = latLngToCanvas(cl.rwyEnd1.lat, cl.rwyEnd1.lng, view)
      const p2 = latLngToCanvas(cl.rwyEnd2.lat, cl.rwyEnd2.lng, view)
      ctx.beginPath()
      ctx.moveTo(p1.x, p1.y)
      ctx.lineTo(p2.x, p2.y)
      ctx.stroke()
    }
    ctx.setLineDash([])
  }

  if (!units) return

  const globalAngle  = win?.ldrAngleDeg   ?? -45
  const ldrLengthPx  = (win?.ldrLength    ?? 2) * 10
  const ptlMinutes   = win?.ptlLength     ?? 0.5
  const historyLimit = win?.historyLength ?? 5
  const leaderDirs   = win?.leaderDirs    ?? {}

  const plansByUnit = {}
  for (const p of Object.values(plans ?? {})) {
    if (p.unitId != null) plansByUnit[String(p.unitId)] = p
  }
  // Backfill from the association engine's callsign+code match (see
  // transponder-correlation-spec.md §3.3) — plan.unitId is only ever set
  // via the FPE's ctrl-click flow, so a StripBay-created plan would
  // otherwise never show its type/destination line despite being
  // correctly associated.
  for (const [uid, aid] of Object.entries(associated)) {
    if (!plansByUnit[uid] && plans?.[aid]) plansByUnit[uid] = plans[aid]
  }

  ctx.font = '11px "Roboto Mono", monospace'

  for (const [id, unit] of Object.entries(units)) {
    const pos = unit.position
    if (!pos) continue

    const { x, y } = latLngToCanvas(pos.lat, pos.lng, view)
    if (x < -60 || x > view.width + 60 || y < -60 || y > view.height + 60) continue

    // PTL
    if (ptlMinutes > 0 && unit.track != null && unit.speed) {
      const distNm = (unit.speed * M_PER_S_TO_KT * ptlMinutes) / 60
      const { lat: eLat, lng: eLng } = destinationPoint(pos.lat, pos.lng, unit.track * 180 / Math.PI, distNm)
      const ep = latLngToCanvas(eLat, eLng, view)
      ctx.beginPath()
      ctx.strokeStyle = colors.contacts
      ctx.lineWidth   = 0.8
      ctx.moveTo(x, y)
      ctx.lineTo(ep.x, ep.y)
      ctx.stroke()
    }

    // History dots
    const trail = (history ?? {})[id] || []
    for (let i = 0; i < trail.length && i < historyLimit; i++) {
      const hp      = latLngToCanvas(trail[i].lat, trail[i].lng, view)
      const opacity = Math.max(0.15, 0.65 - i * 0.12)
      ctx.beginPath()
      ctx.fillStyle = `rgba(255,255,255,${opacity})`
      ctx.arc(hp.x, hp.y, 3, 0, Math.PI * 2)
      ctx.fill()
    }

    // Symbol — filled triangle rotated by heading. unit.track is a true
    // bearing (radians); the canvas is already rotated by declinationDeg
    // (see projection.js) so screen-up is magnetic north, not true north —
    // subtract the same correction here or the triangle points off by the
    // declination angle.
    //
    // track is TRACS's own bearing computed from consecutive position
    // samples (store/units.js) — below ~1 m/s that displacement is too
    // small/noisy to trust, so track just freezes at its last real heading
    // rather than tracking a stationary unit's nose as it pivots (e.g. a
    // helicopter doing a pedal turn, or pushback rotation). unit.heading is
    // DCS's own raw engine-frame heading, in the same true-bearing frame as
    // track (see utils/bearing.js), so it's a direct substitute — no
    // separate correction needed beyond the same declination term below.
    // Unknown Target: real transponder standby, or status normal/ident with
    // no mode3 code set (e.g. military mode4-only) — either way "no
    // information is known about a Target." Symbol still shows (ASDE-X is
    // surface radar, sees the physical return regardless of transponder
    // state) but in teal, with no datablock at all. Only for srsCapable
    // units — AI/non-SRS units keep the old full-identity fallback. See
    // resources/specs/transponder-correlation-spec.md §5.
    // A manual .TAG turns an Unknown Target into a normal, identified one.
    const isUnknownTarget = !!unit.srsCapable && !hasLiveSquawk(unit) && !manualTags[String(id)]

    const useHeading = unit.speed != null && unit.speed < 1 && unit.heading != null
    const symbolTrack = useHeading ? unit.heading : (unit.track ?? 0)
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(symbolTrack - (view.declinationDeg ?? 0) * Math.PI / 180)
    ctx.beginPath()
    ctx.moveTo(0, -7)
    ctx.lineTo(5, 5)
    ctx.lineTo(-5, 5)
    ctx.closePath()
    ctx.fillStyle = isUnknownTarget ? UNKNOWN_TARGET_COLOR : colors.contacts
    ctx.fill()
    ctx.restore()

    if (isUnknownTarget) continue // no leader line, no datablock

    // Leader line
    const unitDir    = leaderDirs[String(id)]
    const angleDeg   = unitDir != null ? (DIR_TO_ANGLE[unitDir] ?? globalAngle) : globalAngle
    const angleRad   = angleDeg * Math.PI / 180
    const ldx        = Math.cos(angleRad) * ldrLengthPx
    const ldy        = Math.sin(angleRad) * ldrLengthPx
    const rightAlign = RIGHT_ALIGN_ANGLES.has(angleDeg)

    const lx0 = x + Math.cos(angleRad) * SYMBOL_R
    const ly0 = y + Math.sin(angleRad) * SYMBOL_R
    const lx1 = x + ldx
    const ly1 = y + ldy
    ctx.beginPath()
    ctx.strokeStyle = colors.contacts
    ctx.lineWidth   = 0.8
    ctx.moveTo(lx0, ly0)
    ctx.lineTo(lx1, ly1)
    ctx.stroke()

    // Datablock — Partial Data Block: field B (aircraft ID) once associated
    // (real match, or manually tagged) or field C (beacon code only)
    // otherwise. Non-srsCapable units keep the old always-full-ID behavior.
    // Real safety-logic-alert-driven Full Data Blocks aren't implemented —
    // no such alert logic exists in TRACS yet. See
    // resources/specs/transponder-correlation-spec.md §5.
    const isKnown = !unit.srsCapable || !!associated[String(id)] || !!manualTags[String(id)]
    const beacon  = unit.transponder?.mode3 != null ? String(unit.transponder.mode3).padStart(4, '0') : null
    const line1   = isKnown ? resolveCallsign(unit).toUpperCase() : beacon

    if (line1) {
      const plan  = plansByUnit[String(id)]
      const typ   = plan?.typ  ? plan.typ.trim()  : ''
      const dest  = plan?.dest ? plan.dest.trim() : ''
      const line2 = isKnown ? [typ, dest].filter(Boolean).join(' ') : ''
      const tx    = lx1 + (rightAlign ? -2 : 2)

      ctx.fillStyle    = colors.datablock
      ctx.textAlign    = rightAlign ? 'right' : 'left'
      ctx.textBaseline = 'alphabetic'
      ctx.fillText(line1, tx, ly1)
      if (line2) ctx.fillText(line2, tx, ly1 + 13)
    }
  }
}
