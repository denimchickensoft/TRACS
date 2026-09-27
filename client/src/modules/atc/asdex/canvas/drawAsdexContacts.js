import { latLngToCanvas }  from '../../../../utils/projection.js'
import { resolveCallsign } from '../../../../utils/callsign.js'
import { destinationPoint } from '../../../../utils/bearing.js'
import { DIR_TO_ANGLE }    from '../../../../utils/scopeConstants.js'
import { hasLiveSquawk }   from '../../../../utils/transponder.js'
import { MS_TO_KT as M_PER_S_TO_KT, M_TO_FT } from '../../../../utils/units.js'

const LINE_H               = 13
const TIMESHARE_MS         = 2000 // line 2: F/H/I <-> J/K scratchpad alternation per phase
const SYMBOL_R             = 7
const RIGHT_ALIGN_ANGLES   = new Set([90, 135, 180, 225])
const UNKNOWN_TARGET_COLOR = '#00e0d0' // teal — real transponder standby (status 0)

// unitId -> flight plan, rebuilt only when the plans or associations
// objects change (the stores replace them on every update), not on every
// frame.
let _plansByUnitCache = { plans: null, associated: null, value: {} }
function getPlansByUnit(plans, associated) {
  if (_plansByUnitCache.plans === plans && _plansByUnitCache.associated === associated) {
    return _plansByUnitCache.value
  }
  const plansByUnit = {}
  for (const p of Object.values(plans ?? {})) {
    if (p.unitId != null) plansByUnit[String(p.unitId)] = p
  }
  // Backfill from the association engine's callsign+code match — plan.unitId
  // is only ever set via the FPE's ctrl-click flow, so a StripBay-created plan
  // would otherwise never show its type/destination line despite being
  // correctly associated.
  for (const [uid, aid] of Object.entries(associated ?? {})) {
    if (!plansByUnit[uid] && plans?.[aid]) plansByUnit[uid] = plans[aid]
  }
  _plansByUnitCache = { plans, associated, value: plansByUnit }
  return plansByUnit
}

// extras: { scratchpads: { unitId: { sp1, sp2 } }, dupBeacon: Set<unitId>, pairedFixFor: (plan) => string }
export function drawAsdexContacts(ctx, view, units, win, plans, history, centerlines, centerlineVisible, colors, associated = {}, manualTags = {}, extras = {}) {
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

  // DB ON/OFF + per-track click toggle, and DB EDIT field toggles
  const dbOn       = win?.dbOn       ?? true
  const dbToggled  = win?.dbToggled  ?? {}
  const dbFull     = win?.dbFull     ?? true
  const dbAltitude = win?.dbAltitude ?? true
  const dbType     = win?.dbType     ?? true
  const dbFix      = win?.dbFix      ?? true
  const dbVelocity = win?.dbVelocity ?? true
  const dbScratch  = win?.dbScratch  ?? true
  const scratchpads  = extras.scratchpads  ?? {}
  const dupBeacon    = extras.dupBeacon    ?? new Set()
  const pairedFixFor = extras.pairedFixFor ?? (() => '')
  const sharePhase   = Math.floor(Date.now() / TIMESHARE_MS) % 2

  const plansByUnit = getPlansByUnit(plans, associated)

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
    // units — AI/non-SRS units keep the full-identity fallback.
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
    if (dbOn === !!dbToggled[String(id)]) continue // Data Block toggled off (globally or per track)

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

    // Datablock (CRC ASDE-X fields). Field B (aircraft ID) once associated
    // (real match, or manually tagged), field C (beacon code) otherwise.
    // Non-srsCapable units keep the old always-full-ID behavior. Real
    // safety-logic alerts aren't implemented.
    //   Line 0: A  (DUP BCN)
    //   Line 1: B|C  D (altitude, FULL only)
    //   Line 2: F H I, timeshared with J K (FULL only)
    // E (sensor coverage) and G (category) are deliberately not implemented.
    const uid     = String(id)
    const isKnown = !unit.srsCapable || !!associated[uid] || !!manualTags[uid]
    const beacon  = unit.transponder?.mode3 != null ? String(unit.transponder.mode3).padStart(4, '0') : null
    const ident   = isKnown ? resolveCallsign(unit).toUpperCase() : beacon

    if (ident) {
      const line0 = dupBeacon.has(uid) ? 'DUP BCN' : ''

      let line1 = ident
      let line2 = ''
      if (dbFull) {
        if (dbAltitude) {
          // No Mode C without a live squawk — only for SRS-fielded units;
          // non-SRS units fall back to ground truth like their callsign does.
          const noModeC = !!unit.srsCapable && !hasLiveSquawk(unit)
          const altHds  = Math.max(0, Math.round((pos.alt ?? 0) * M_TO_FT / 100))
          line1 += ' ' + (noModeC ? 'XXX' : String(altHds).padStart(3, '0'))
        }

        const plan  = isKnown ? plansByUnit[uid] : null
        const typ   = dbType && plan?.typ ? plan.typ.trim() : ''
        const fix   = dbFix  && plan ? pairedFixFor(plan) : ''
        const vel   = dbVelocity && unit.speed != null
          ? String(Math.round(unit.speed * M_PER_S_TO_KT / 10)).padStart(2, '0')
          : ''
        const fieldsFHI = [typ, fix, vel].filter(Boolean).join(' ')

        const pads     = dbScratch ? scratchpads[uid] : null
        const fieldsJK = [pads?.sp1, pads?.sp2].filter(Boolean).join(' ')

        if (fieldsJK && fieldsFHI) line2 = sharePhase === 1 ? fieldsJK : fieldsFHI
        else                       line2 = fieldsJK || fieldsFHI
      }

      const tx = lx1 + (rightAlign ? -2 : 2)
      ctx.fillStyle    = colors.datablock
      ctx.textAlign    = rightAlign ? 'right' : 'left'
      ctx.textBaseline = 'alphabetic'
      if (line0) ctx.fillText(line0, tx, ly1 - LINE_H)
      ctx.fillText(line1, tx, ly1)
      if (line2) ctx.fillText(line2, tx, ly1 + LINE_H)
    }
  }
}
